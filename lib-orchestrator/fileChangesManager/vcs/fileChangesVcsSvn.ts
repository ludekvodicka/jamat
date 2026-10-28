import { stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import { PathCompare } from '../../shared/pathCompare'
import type {
  FileChangeProperties,
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
import { SvnConflictFacts } from '../../svn/svnConflictFacts'

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
    filePath?: string,
  ): Promise<FileChangesVcsResult<FileChangesVcsStatus>> {
    // No `--verbose`: it prints an XML entry for every VERSIONED node, and `statusOf` throws all of
    // those away - a working copy of forty thousand files then overran the reader's output ceiling
    // and the panel said "0 changed" about a tree full of changes. Plain `--xml` still reports a
    // property-only change, which is the one thing `--verbose` was thought to be needed for, and
    // `--depth infinity` is what `status` does anyway.
    let target = filePath
    while (true) {
      const outcome = await this.runner.run(detection.cwd, [
        'status', '--xml', '--non-interactive',
        ...(target === undefined ? [] : ['--depth', 'empty']),
        '--', target === undefined ? '.' : `${target}@`,
      ])
      if (!FileChangesVcsSvn.succeeded(outcome))
        return { ok: false, detail: this.detailOf(outcome) }
      try {
        const { nested, ...value } = await this.parseStatus(detection, outcome.stdout)
        // SVN cannot address a child below an unversioned directory. Find that directory so the
        // existing untracked reader can apply ignore rules without scanning the whole scope.
        if (target !== undefined && value.entries.length === 0 && outcome.stderr.includes('W155010')
          && PathCompare.isInside(detection.cwd, dirname(target))
          && PathCompare.comparable(target) !== PathCompare.comparable(detection.cwd)) {
          target = dirname(target)
          continue
        }
        return nested.length === 0 ? { ok: true, value } : await this.withNested(detection, value, nested)
      }
      catch (error) { return { ok: false, detail: ErrorText.of(error) } }
    }
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
      `${target}@`,
    ], { stdoutBytes: true })
    if (FileChangesVcsSvn.succeeded(outcome)) return { kind: 'content', content: outcome.stdoutBytes ?? outcome.stdout }
    const detail = this.detailOf(outcome)
    if (baseline.kind === 'svn-base' && /has no pristine version/i.test(detail)) {
      const replaced = await this.replacedBaseline(detection, target)
      if (replaced !== null) return replaced
    }
    if (outcome.failure !== null) return { kind: 'unavailable', detail }
    return /not found|does not exist|is not a file|E200009|W160013/i.test(detail)
      ? { kind: 'missing', detail }
      : { kind: 'unavailable', detail }
  }

  /**
   * A replaced node (an add over a versioned one, as an add/add conflict leaves it) has no pristine,
   * so `svn cat -r BASE` refuses it; its status still names the revision it replaced, whose file is
   * the incoming side. `svn info` gives no revision for such a node.
   */
  private async replacedBaseline(detection: FileChangesVcsDetection, target: string): Promise<FileChangesVcsContentResult | null> {
    const status = await this.runner.run(detection.root, ['status', '--xml', '--depth', 'empty', '--non-interactive', '--', `${target}@`])
    if (!FileChangesVcsSvn.succeeded(status)) return null
    const entry = FileChangesVcsSvn.objectOf(FileChangesVcsSvn.objectOf(FileChangesVcsSvn.objectOf(
      (this.parser.parse(status.stdout) as XmlNode).status).target).entry)
    const revision = Number(FileChangesVcsSvn.objectOf(entry['wc-status'])['@_revision'])
    if (!Number.isSafeInteger(revision) || revision < 1) return null
    const outcome = await this.runner.run(detection.root, ['cat', '--non-interactive', '-r', String(revision), '--', `${target}@${revision}`],
      { stdoutBytes: true })
    return FileChangesVcsSvn.succeeded(outcome) ? { kind: 'content', content: outcome.stdoutBytes ?? outcome.stdout } : null
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

  /**
   * Reads the working copies SVN status stepped over and adds their changes.
   *
   * A group working copy holds projects that are their own checkouts of the same repository, and
   * SVN reports such a project as `?` or, when its node is excluded and externals are registered
   * below it, as an `X` it never walks. Its changes were then absent from the list, and a review
   * that selected them committed the rest and reported every path as committed
   * (`nodejs/AppJamatV3#28`). One `svn commit` publishes targets of several working copies of one
   * repository in one revision, so a nested checkout of that repository joins the main group; one
   * of another repository becomes its own group, exactly like an external. An `X` counts only when
   * it is checked out at its own path: a registered external has already been walked, and a clean
   * one has no target of its own in the XML to say so.
   */
  private async withNested(
    detection: FileChangesVcsDetection,
    value: FileChangesVcsStatus,
    nested: readonly { path: string; external: boolean }[],
  ): Promise<FileChangesVcsResult<FileChangesVcsStatus>> {
    const outcome = await this.runner.run(detection.cwd, [
      'info', '--xml', '--non-interactive', '--', '.@', ...nested.map((candidate) => `${candidate.path}@`),
    ])
    if (!FileChangesVcsSvn.succeeded(outcome))
      return { ok: false, detail: `Could not read a nested working copy: ${this.detailOf(outcome)}` }
    const infos = new Map<string, { url: string; relativeUrl: string; root: string; wcRoot: string }>()
    for (const raw of FileChangesVcsSvn.arrayOf(FileChangesVcsSvn.objectOf(
      (this.parser.parse(outcome.stdout) as XmlNode).info).entry)) {
      const entry = FileChangesVcsSvn.objectOf(raw)
      infos.set(PathCompare.comparable(resolve(detection.cwd, String(entry['@_path'] ?? ''))), {
        url: FileChangesVcsSvn.textOf(entry.url),
        relativeUrl: FileChangesVcsSvn.textOf(entry['relative-url']),
        root: FileChangesVcsSvn.textOf(FileChangesVcsSvn.objectOf(entry.repository).root),
        wcRoot: FileChangesVcsSvn.textOf(FileChangesVcsSvn.objectOf(entry['wc-info'])['wcroot-abspath']),
      })
    }
    const own = infos.get(PathCompare.comparable(detection.cwd))
    if (own === undefined) throw new Error('SVN info did not describe the requested scope')
    const entries = new Map(value.entries.map((entry) => [PathCompare.normalized(entry.absolutePath), entry]))
    const externalRoots = new Set(value.externalRoots)
    for (const candidate of nested) {
      const info = infos.get(PathCompare.comparable(candidate.path))
      if (info === undefined || PathCompare.comparable(info.wcRoot) !== PathCompare.comparable(candidate.path)) continue
      const sameRepository = info.root === own.root
      const atOwnPath = sameRepository && FileChangesVcsSvn.decodedUrl(info.relativeUrl)
        === `${FileChangesVcsSvn.decodedUrl(own.relativeUrl)}/${FileChangesVcsSvn.repositoryPath(relative(detection.cwd, candidate.path))}`
      if (candidate.external && !atOwnPath) continue
      const status = await this.status({
        id: this.id,
        root: candidate.path,
        cwd: candidate.path,
        scopeRelativePath: '.',
        scopeUrl: info.url.replace(/\/$/, ''),
        repositoryPathPrefix: info.relativeUrl.replace(/^\^/, '').replace(/\/$/, ''),
      })
      if (!status.ok) return { ok: false, detail: `${candidate.path}: ${status.detail}` }
      if (sameRepository) externalRoots.delete(candidate.path)
      else externalRoots.add(candidate.path)
      for (const root of status.value.externalRoots) externalRoots.add(root)
      for (const entry of status.value.entries)
        if (!entries.has(PathCompare.normalized(entry.absolutePath)))
          entries.set(PathCompare.normalized(entry.absolutePath), { ...entry,
            repositoryPath: FileChangesVcsSvn.repositoryPath(relative(detection.root, entry.absolutePath)) })
    }
    return { ok: true, value: { entries: [...entries.values()], externalRoots: [...externalRoots] } }
  }

  private async parseStatus(
    detection: FileChangesVcsDetection,
    xml: string,
  ): Promise<FileChangesVcsStatus & { nested: { path: string; external: boolean }[] }> {
    const document = this.parser.parse(xml) as XmlNode
    const status = FileChangesVcsSvn.objectOf(document.status)
    const entries: XmlNode[] = []
    const walked = new Set<string>()
    for (const target of FileChangesVcsSvn.arrayOf(status.target)) {
      const targetNode = FileChangesVcsSvn.objectOf(target)
      walked.add(PathCompare.comparable(resolve(detection.cwd, String(targetNode['@_path'] ?? '.'))))
      entries.push(...FileChangesVcsSvn.arrayOf(targetNode.entry).map(FileChangesVcsSvn.objectOf))
    }
    const parsed: FileChangesVcsEntry[] = []
    const externalRoots = new Set<string>()
    const nested: { path: string; external: boolean }[] = []
    const propertied = new Set<string>()
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
      if (item === 'external') {
        externalRoots.add(absolutePath)
        if (!walked.has(PathCompare.comparable(absolutePath)) && await FileChangesVcsSvn.workingCopyRoot(absolutePath))
          nested.push({ path: absolutePath, external: true })
      }
      if (mapped === null) continue
      const nodeKind = await FileChangesVcsSvn.nodeKindOf(absolutePath)
      if (mapped === 'untracked' && nodeKind === 'directory' && await FileChangesVcsSvn.workingCopyRoot(absolutePath)) {
        nested.push({ path: absolutePath, external: false })
        continue
      }
      const movedFrom = wcStatus['@_moved-from'] === undefined ? null : resolve(detection.cwd, String(wcStatus['@_moved-from']))
      parsed.push({
        absolutePath,
        repositoryPath: FileChangesVcsSvn.repositoryPath(relative(detection.root, absolutePath)),
        nodeKind,
        status: mapped,
        previousAbsolutePath: movedFrom,
        previousRepositoryPath: movedFrom === null ? null : FileChangesVcsSvn.repositoryPath(relative(detection.root, movedFrom)),
        gitState: null,
      })
      if ((props === 'modified' || props === 'conflicted') && FileChangesVcsSvn.hasWorkingNode(mapped))
        propertied.add(PathCompare.comparable(absolutePath))
    }
    // SVN also marks unversioned mount containers as X, without naming the checkout below them.
    const roots = new Set<string>()
    const workingRoots = new Map<string, boolean>()
    const isRoot = async (path: string): Promise<boolean> => {
      const key = PathCompare.comparable(path)
      if (!workingRoots.has(key)) workingRoots.set(key, await FileChangesVcsSvn.workingCopyRoot(path))
      return workingRoots.get(key)!
    }
    for (const container of externalRoots) {
      if (await isRoot(container)) { roots.add(container); continue }
      for (const entry of parsed.filter((entry) => PathCompare.isInside(container, entry.absolutePath))) {
        let path = entry.nodeKind === 'directory' ? entry.absolutePath : dirname(entry.absolutePath)
        while (PathCompare.isInside(container, path) && !await isRoot(path)) path = dirname(path)
        if (!PathCompare.isInside(container, path))
          throw new Error(`Could not identify the external working copy for ${entry.absolutePath}`)
        roots.add(path)
      }
    }
    const conflicts = parsed.filter((entry) => entry.status === 'conflicted')
    const sidecars = new Set<string>()
    for (let offset = 0; offset < conflicts.length; offset += 64) {
      const outcome = await this.runner.run(detection.cwd, ['info', '--xml', '--non-interactive', '--',
        ...conflicts.slice(offset, offset + 64).map((entry) => `${entry.absolutePath}@`)])
      if (!FileChangesVcsSvn.succeeded(outcome)) throw new Error(`Could not identify SVN conflict files: ${this.detailOf(outcome)}`)
      for (const conflict of SvnConflictFacts.infoConflicts(outcome.stdout))
        for (const path of Object.values(conflict.sidecars))
          if (path !== null) sidecars.add(PathCompare.comparable(resolve(detection.cwd, path)))
    }
    const listed = parsed.filter((entry) => entry.status !== 'untracked' || !sidecars.has(PathCompare.comparable(entry.absolutePath)))
    return { entries: await this.withProperties(detection, listed, propertied), externalRoots: [...roots], nested }
  }

  /**
   * The values behind `props="modified"`, so a review shows what a commit publishes beside content.
   * BASE answers nothing for a node without one (added, replaced): its properties are all new. A
   * failed read keeps the changes list and says why on each node it concerns.
   */
  private async withProperties(
    detection: FileChangesVcsDetection,
    entries: FileChangesVcsEntry[],
    propertied: ReadonlySet<string>,
  ): Promise<FileChangesVcsEntry[]> {
    const nodes = entries.filter((entry) => propertied.has(PathCompare.comparable(entry.absolutePath)))
    if (nodes.length === 0) return entries
    const found = new Map<string, FileChangeProperties>()
    const read = nodes.slice(0, FileChangesLimits.propertyNodesMax)
    for (let offset = 0; offset < read.length; offset += 64) {
      const batch = read.slice(offset, offset + 64)
      const targets = batch.map((entry) => `${entry.absolutePath}@`)
      const working = await this.runner.run(detection.cwd, ['proplist', '--xml', '--verbose', '--non-interactive', '--', ...targets])
      const base = FileChangesVcsSvn.succeeded(working)
        ? await this.runner.run(detection.cwd, ['proplist', '--xml', '--verbose', '--non-interactive', '-r', 'BASE', '--', ...targets])
        : working
      let values: { before: Map<string, Map<string, string>>; after: Map<string, Map<string, string>> } | string
      if (!FileChangesVcsSvn.succeeded(base)) values = this.detailOf(base)
      else {
        try { values = { before: FileChangesVcsSvn.propertiesByPath(detection, base.stdout), after: FileChangesVcsSvn.propertiesByPath(detection, working.stdout) } }
        catch (error) { values = ErrorText.of(error) }
      }
      for (const entry of batch) {
        const key = PathCompare.comparable(entry.absolutePath)
        found.set(key, typeof values === 'string' ? { changes: [], detail: `Property values could not be read: ${values}` }
          : FileChangesVcsSvn.propertyChangesOf(values.before.get(key) ?? new Map(), values.after.get(key) ?? new Map()))
      }
    }
    const unread: FileChangeProperties = { changes: [], detail: `Property values are read for the first ${FileChangesLimits.propertyNodesMax} nodes only.` }
    return entries.map((entry) => {
      const key = PathCompare.comparable(entry.absolutePath)
      return propertied.has(key) ? { ...entry, properties: found.get(key) ?? unread } : entry
    })
  }

  private static propertiesByPath(detection: FileChangesVcsDetection, xml: string): Map<string, Map<string, string>> {
    const byPath = new Map<string, Map<string, string>>()
    for (const [path, values] of SvnConflictFacts.propertiesOf(xml))
      byPath.set(PathCompare.comparable(resolve(detection.cwd, path)), values)
    return byPath
  }

  private static propertyChangesOf(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): FileChangeProperties {
    const max = FileChangesLimits.propertyValueCharactersMax
    let cut = false
    const shown = (value: string | undefined): string | null => {
      if (value === undefined) return null
      if (value.length <= max) return value
      cut = true
      return `${value.slice(0, max)}…`
    }
    const changes = [...new Set([...before.keys(), ...after.keys()])].sort()
      .filter((name) => before.get(name) !== after.get(name))
      .map((name) => ({ name, before: shown(before.get(name)), after: shown(after.get(name)) }))
    return { changes, detail: cut ? `Values longer than ${max} characters are cut.` : null }
  }

  /** A node the working copy still holds properties of; a deleted, missing or unversioned one has none to read. */
  private static hasWorkingNode(status: FileChangeStatus): boolean {
    switch (status) {
      case 'added': case 'modified': case 'replaced': case 'copied': case 'renamed': case 'conflicted': return true
      case 'deleted': case 'missing': case 'untracked': case 'obstructed': return false
      default: throw new Error(`Unknown file change status: ${status satisfies never}`)
    }
  }

  private static async workingCopyRoot(path: string): Promise<boolean> {
    return await stat(join(path, '.svn')).then((value) => value.isDirectory(), () => false)
  }

  private static decodedUrl(url: string): string {
    try { return decodeURIComponent(url).replace(/\/$/, '') }
    catch { return url }
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
