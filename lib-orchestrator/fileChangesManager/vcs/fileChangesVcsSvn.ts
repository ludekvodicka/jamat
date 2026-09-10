import { relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import { PathCompare } from '../../shared/pathCompare'
import type {
  FileChangeStatus,
  FileChangesVcsDetection,
  FileChangesVcsResult,
} from '../fileChangesManagerApi.types'
import type {
  FileChangesVcs,
  FileChangesVcsBaselineRef,
  FileChangesVcsContentResult,
  FileChangesVcsEntry,
  FileChangesVcsHistoryGroup,
  FileChangesVcsStatus,
} from './fileChangesVcs.types'
import { ErrorText } from '../../shared/errorText'
import { JsonShape } from '../../shared/jsonShape'
import { FileChangesLimits } from '../fileChangesLimits'
import type { CommandOutcome, CommandRunner } from '../../shared/commandInvoker.types'
import { FileChangesVcsBase } from './fileChangesVcsBase'
import { SvnInvoker } from '../../svn/svnInvoker'

interface XmlNode {
  [key: string]: unknown
  '#text'?: string
}

export class FileChangesVcsSvn extends FileChangesVcsBase implements FileChangesVcs {
  readonly id = 'svn' as const
  protected readonly toolName = 'svn'
  readonly defaultBaselineRef: FileChangesVcsBaselineRef = { kind: 'svn-base', revision: 'BASE' }

  historyBaselineRef(revision: string): FileChangesVcsBaselineRef {
    return { kind: 'svn-revision', revision }
  }

  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: false,
  })

  constructor(
    private readonly runner: CommandRunner = new SvnInvoker({
      timeoutMilliseconds: FileChangesLimits.readTimeoutMilliseconds,
    }),
  ) {
    super()
  }

  async detect(cwd: string): Promise<FileChangesVcsDetection | null> {
    const [rootOutcome, urlOutcome, relativeUrlOutcome] = await Promise.all([
      this.infoItem(cwd, 'wc-root'),
      this.infoItem(cwd, 'url'),
      this.infoItem(cwd, 'relative-url'),
    ])
    if (!FileChangesVcsSvn.succeeded(rootOutcome)
      || !FileChangesVcsSvn.succeeded(urlOutcome)
      || !FileChangesVcsSvn.succeeded(relativeUrlOutcome))
      return null
    const root = resolve(rootOutcome.stdout.trim())
    const normalizedCwd = resolve(cwd)
    if (!PathCompare.isInside(root, normalizedCwd)) return null
    return {
      id: this.id,
      root,
      cwd: normalizedCwd,
      scopeRelativePath: FileChangesVcsSvn.repositoryPath(relative(root, normalizedCwd)) || '.',
      scopeUrl: urlOutcome.stdout.trim().replace(/\/$/, ''),
      repositoryPathPrefix: relativeUrlOutcome.stdout.trim().replace(/^\^/, '').replace(/\/$/, ''),
    }
  }

  async status(
    detection: FileChangesVcsDetection,
  ): Promise<FileChangesVcsResult<FileChangesVcsStatus>> {
    // No `--verbose`: it prints an XML entry for every VERSIONED node, and `statusOf` throws all of
    // those away - a working copy of forty thousand files then overran the reader's output ceiling
    // and the panel said "0 changed" about a tree full of changes. Plain `--xml` still reports a
    // property-only change, which is the one thing `--verbose` was thought to be needed for, and
    // `--depth infinity` is what `status` does anyway.
    const outcome = await this.runner.run(detection.cwd, [
      'status',
      '--xml',
      '--non-interactive',
      '--',
      '.',
    ])
    if (!FileChangesVcsSvn.succeeded(outcome))
      return { ok: false, detail: this.detailOf(outcome) }
    try { return { ok: true, value: await this.parseStatus(detection, outcome.stdout) } }
    catch (error) { return { ok: false, detail: ErrorText.of(error) } }
  }

  /**
   * Deliberately NOT the `--xml --verbose --depth infinity` form `status()` uses: that one reports
   * every versioned node and walks the whole working copy, which is the cost this probe exists to
   * avoid. Plain `status` prints only what changed.
   *
   * An `X` row is the external itself rather than a change inside it. The narration svn prints while
   * descending into an external is NOT filtered, because `--ignore-externals` means it never
   * descends: a filter for output this call cannot produce is a filter nobody can check. An
   * unversioned `?` counts as dirt, for parity with git.
   */
  async dirty(detection: FileChangesVcsDetection): Promise<FileChangesVcsResult<boolean>> {
    const outcome = await this.runner.run(detection.cwd, [
      'status',
      '--ignore-externals',
      '--non-interactive',
      '--',
      '.',
    ])
    if (!FileChangesVcsSvn.succeeded(outcome))
      return { ok: false, detail: this.detailOf(outcome) }
    const changed = outcome.stdout.split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0 && !line.startsWith('X'))
    return { ok: true, value: changed.length > 0 }
  }

  async history(
    detection: FileChangesVcsDetection,
    limit: number,
  ): Promise<FileChangesVcsResult<readonly FileChangesVcsHistoryGroup[]>> {
    const outcome = await this.runner.run(detection.cwd, [
      'log',
      '--xml',
      '--verbose',
      '--limit',
      String(Math.max(1, limit)),
      '--non-interactive',
      '--',
      '.',
    ])
    if (!FileChangesVcsSvn.succeeded(outcome))
      return { ok: false, detail: this.detailOf(outcome) }
    try { return { ok: true, value: await this.parseHistory(detection, outcome.stdout) } }
    catch (error) { return { ok: false, detail: ErrorText.of(error) } }
  }

  async readBaseline(
    detection: FileChangesVcsDetection,
    repositoryPath: string,
    baseline: FileChangesVcsBaselineRef,
  ): Promise<FileChangesVcsContentResult> {
    let target: string
    let revision: string
    if (baseline.kind === 'svn-base') {
      target = resolve(detection.root, repositoryPath)
      revision = baseline.revision
    }
    else if (baseline.kind === 'svn-revision') {
      target = FileChangesVcsSvn.urlFor(detection, repositoryPath)
      revision = baseline.revision
    }
    else
      throw new Error(`SVN cannot read baseline: ${JSON.stringify(baseline)}`)
    const outcome = await this.runner.run(detection.root, [
      'cat',
      '--non-interactive',
      '-r',
      revision,
      '--',
      target,
    ])
    if (FileChangesVcsSvn.succeeded(outcome)) return { kind: 'content', content: outcome.stdout }
    const detail = this.detailOf(outcome)
    if (outcome.failure !== null) return { kind: 'unavailable', detail }
    return /not found|does not exist|is not a file|E200009|W160013/i.test(detail)
      ? { kind: 'missing', detail }
      : { kind: 'unavailable', detail }
  }

  private infoItem(cwd: string, item: string): Promise<CommandOutcome> {
    return this.runner.run(cwd, [
      'info',
      '--show-item',
      item,
      '--no-newline',
      '--non-interactive',
      '--',
      '.',
    ])
  }

  private async parseStatus(
    detection: FileChangesVcsDetection,
    xml: string,
  ): Promise<FileChangesVcsStatus> {
    const document = this.parser.parse(xml) as XmlNode
    const status = FileChangesVcsSvn.objectOf(document.status)
    const entries: XmlNode[] = []
    for (const target of FileChangesVcsSvn.arrayOf(status.target)) {
      const targetNode = FileChangesVcsSvn.objectOf(target)
      entries.push(...FileChangesVcsSvn.arrayOf(targetNode.entry).map(FileChangesVcsSvn.objectOf))
    }
    const parsed: FileChangesVcsEntry[] = []
    const externalRoots = new Set<string>()
    for (const entry of entries) {
      const wcStatus = FileChangesVcsSvn.objectOf(entry['wc-status'])
      const item = String(wcStatus['@_item'] ?? '')
      const props = String(wcStatus['@_props'] ?? 'none')
      const treeConflicted = String(wcStatus['@_tree-conflicted'] ?? '') === 'true'
      const mapped = FileChangesVcsSvn.statusOf(item, props, treeConflicted)
      if (mapped === null && item !== 'external') continue
      const entryPath = String(entry['@_path'] ?? '')
      if (!entryPath) throw new Error('SVN status entry has no path')
      const absolutePath = resolve(detection.cwd, entryPath)
      if (!PathCompare.isInside(detection.cwd, absolutePath))
        throw new Error(`SVN returned a path outside its requested scope: ${entryPath}`)
      if (item === 'external') externalRoots.add(absolutePath)
      if (mapped === null) continue
      parsed.push({
        absolutePath,
        repositoryPath: FileChangesVcsSvn.localRepositoryPath(detection, entryPath),
        nodeKind: await FileChangesVcsSvn.nodeKindOf(absolutePath),
        status: mapped,
        previousAbsolutePath: null,
        previousRepositoryPath: null,
        gitState: null,
      })
    }
    return { entries: parsed, externalRoots: [...externalRoots] }
  }

  private async parseHistory(
    detection: FileChangesVcsDetection,
    xml: string,
  ): Promise<FileChangesVcsHistoryGroup[]> {
    const document = this.parser.parse(xml) as XmlNode
    const log = FileChangesVcsSvn.objectOf(document.log)
    const groups: FileChangesVcsHistoryGroup[] = []
    for (const rawEntry of FileChangesVcsSvn.arrayOf(log.logentry)) {
      const entry = FileChangesVcsSvn.objectOf(rawEntry)
      const revision = String(entry['@_revision'] ?? '')
      const createdAt = Date.parse(FileChangesVcsSvn.textOf(entry.date))
      if (!revision || Number.isNaN(createdAt))
        throw new Error(`Unknown SVN log entry: ${JSON.stringify(entry)}`)
      const paths = FileChangesVcsSvn.objectOf(entry.paths)
      const changes: FileChangesVcsEntry[] = []
      for (const rawPath of FileChangesVcsSvn.arrayOf(paths.path)) {
        const path = FileChangesVcsSvn.objectOf(rawPath)
        const repositoryAbsolutePath = FileChangesVcsSvn.textOf(rawPath)
        const localPath = FileChangesVcsSvn.localPathFromRepository(detection, repositoryAbsolutePath)
        if (localPath === null) continue
        const action = String(path['@_action'] ?? '')
        const copyFrom = path['@_copyfrom-path'] === undefined
          ? null
          : String(path['@_copyfrom-path'])
        const previousLocalPath = copyFrom === null
          ? null
          : FileChangesVcsSvn.localPathFromRepository(detection, copyFrom)
        const absolutePath = resolve(detection.cwd, localPath)
        changes.push({
          absolutePath,
          repositoryPath: FileChangesVcsSvn.localRepositoryPath(detection, localPath),
          nodeKind: String(path['@_kind'] ?? '') === 'dir'
            ? 'directory'
            : await FileChangesVcsSvn.nodeKindOf(absolutePath),
          status: FileChangesVcsSvn.historyStatusOf(action, copyFrom !== null),
          previousAbsolutePath: previousLocalPath === null
            ? null
            : resolve(detection.cwd, previousLocalPath),
          previousRepositoryPath: previousLocalPath === null
            ? null
            : FileChangesVcsSvn.localRepositoryPath(detection, previousLocalPath),
          gitState: null,
        })
      }
      groups.push({
        id: revision,
        revision,
        label: `r${revision}`,
        author: FileChangesVcsSvn.nullableTextOf(entry.author),
        message: FileChangesVcsSvn.nullableTextOf(entry.msg),
        createdAt,
        entries: changes,
      })
    }
    return groups
  }

  private static statusOf(
    item: string,
    props: string,
    treeConflicted: boolean,
  ): FileChangeStatus | null {
    if (treeConflicted || item === 'conflicted' || props === 'conflicted') return 'conflicted'
    if (item === 'normal' || item === 'none' || item === 'external' || item === 'ignored')
      return props === 'modified' ? 'modified' : null
    else if (item === 'added') return 'added'
    else if (item === 'modified' || item === 'merged') return 'modified'
    else if (item === 'deleted') return 'deleted'
    else if (item === 'replaced') return 'replaced'
    else if (item === 'unversioned') return 'untracked'
    else if (item === 'missing') return 'missing'
    else if (item === 'obstructed' || item === 'incomplete') return 'obstructed'
    else
      throw new Error(`Unknown SVN status: ${JSON.stringify({ item, props, treeConflicted })}`)
  }

  private static historyStatusOf(action: string, copied: boolean): FileChangeStatus {
    if (action === 'A') return copied ? 'copied' : 'added'
    else if (action === 'M') return 'modified'
    else if (action === 'D') return 'deleted'
    else if (action === 'R') return 'replaced'
    else
      throw new Error(`Unknown SVN history action: ${JSON.stringify(action)}`)
  }

  private static localPathFromRepository(
    detection: FileChangesVcsDetection,
    repositoryAbsolutePath: string,
  ): string | null {
    const prefix = detection.repositoryPathPrefix
    if (prefix === null) throw new Error('SVN detection has no repository path prefix')
    const normalized = `/${repositoryAbsolutePath.replace(/^\/+/, '')}`
    if (normalized === prefix) return '.'
    if (!normalized.startsWith(`${prefix}/`)) return null
    return normalized.slice(prefix.length + 1)
  }

  private static localRepositoryPath(
    detection: FileChangesVcsDetection,
    pathFromCwd: string,
  ): string {
    const clean = FileChangesVcsSvn.repositoryPath(pathFromCwd)
    if (detection.scopeRelativePath === '.') return clean === '.' ? '' : clean
    if (!clean || clean === '.') return detection.scopeRelativePath
    return `${detection.scopeRelativePath}/${clean}`
  }

  private static urlFor(detection: FileChangesVcsDetection, repositoryPath: string): string {
    if (detection.scopeUrl === null) throw new Error('SVN detection has no scope URL')
    const scope = detection.scopeRelativePath
    const relativePath = FileChangesVcsSvn.repositoryPath(relative(scope, repositoryPath))
    if (relativePath.startsWith('../'))
      throw new Error(`SVN baseline path is outside the requested scope: ${repositoryPath}`)
    const suffix = relativePath === '.' ? '' : relativePath
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')
    return suffix ? `${detection.scopeUrl}/${suffix}` : detection.scopeUrl
  }

  private static textOf(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    const node = JsonShape.record(value)
    if (node !== null) return String(node['#text'] ?? '')
    return ''
  }

  private static nullableTextOf(value: unknown): string | null {
    const text = FileChangesVcsSvn.textOf(value).trim()
    return text || null
  }

  private static objectOf(value: unknown): XmlNode {
    return (JsonShape.record(value) ?? {}) as XmlNode
  }

  private static arrayOf(value: unknown): unknown[] {
    if (value === undefined || value === null) return []
    return Array.isArray(value) ? value : [value]
  }

}
