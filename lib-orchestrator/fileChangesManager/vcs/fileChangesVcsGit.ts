import { relative, resolve } from 'node:path'

import type { GitCommandOutcome, GitCommandRunner } from '../../git/git.types'
import { GitInvoker } from '../../git/gitInvoker'
import { BoundedMap } from '../../shared/boundedMap'
import { PathCompare } from '../../shared/pathCompare'
import { FileChangesLimits } from '../fileChangesLimits'
import { FileChangesVcsBase } from './fileChangesVcsBase'
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

interface GitHistoryHeader {
  hash: string
  author: string
  createdAt: number
  message: string
}

export class FileChangesVcsGit extends FileChangesVcsBase implements FileChangesVcs {
  readonly id = 'git' as const
  protected readonly toolName = 'git'
  readonly defaultBaselineRef: FileChangesVcsBaselineRef = { kind: 'git-head', revision: 'HEAD' }

  historyBaselineRef(revision: string): FileChangesVcsBaselineRef {
    return { kind: 'git-commit', revision }
  }

  /** What git says when the path really is not in that revision, as opposed to any other failure. */
  private static readonly missingPathConst =
    /does not exist in|exists on disk, but not in|invalid object name|unknown revision or path/i

  constructor(
    private readonly runner: GitCommandRunner = new GitInvoker({
      timeoutMilliseconds: FileChangesLimits.readTimeoutMilliseconds,
    }),
    private readonly commandArgs: readonly string[] = [],
  ) {
    super()
  }

  /**
   * The scope, spelled so git reads it as a path and not as a pattern.
   *
   * Everything after `--` is a pathspec, and a pathspec has glob magic: `[`, `]`, `*` and `?` are
   * legal in a directory name (all four on POSIX, the brackets on Windows too). A session in
   * `C:\proj\app [old]` therefore asked git about the pattern `app [old]`, which matches one
   * character out of {o,l,d} and so matched nothing - and an empty answer here is `0 changed` in the
   * panel and a CLEAN mark on the session, which is what the Finish affordance reads.
   */
  private static pathspecOf(detection: FileChangesVcsDetection): string {
    return `:(literal)${detection.scopeRelativePath}`
  }

  async detect(cwd: string): Promise<FileChangesVcsDetection | null> {
    const outcome = await this.run(cwd, ['rev-parse', '--show-toplevel'])
    if (!FileChangesVcsGit.succeeded(outcome)) return null
    const root = resolve(outcome.stdout.trim())
    const normalizedCwd = resolve(cwd)
    if (!PathCompare.isInside(root, normalizedCwd)) return null
    return {
      id: this.id,
      root,
      cwd: normalizedCwd,
      scopeRelativePath: FileChangesVcsGit.repositoryPath(relative(root, normalizedCwd)) || '.',
      scopeUrl: null,
      repositoryPathPrefix: null,
    }
  }

  async status(
    detection: FileChangesVcsDetection,
  ): Promise<FileChangesVcsResult<FileChangesVcsStatus>> {
    const outcome = await this.run(detection.root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=no',
      '--',
      FileChangesVcsGit.pathspecOf(detection),
    ])
    if (!FileChangesVcsGit.succeeded(outcome))
      return { ok: false, detail: this.detailOf(outcome) }
    return { ok: true, value: { entries: await this.parseStatus(detection, outcome.stdout), externalRoots: [] } }
  }

  /**
   * Every tracked change between an explicit commit and the current work tree, plus porcelain-only
   * facts such as untracked paths, conflicts and index/worktree state.
   */
  async statusAgainst(
    detection: FileChangesVcsDetection,
    baseRef: string,
  ): Promise<FileChangesVcsResult<{
    revision: string
    entries: readonly FileChangesVcsEntry[]
    externalRoots: readonly string[]
  }>> {
    const verified = await this.run(detection.root, [
      'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`,
    ])
    if (!FileChangesVcsGit.succeeded(verified))
      return { ok: false, detail: this.detailOf(verified) }
    const revision = verified.stdout.trim()
    if (!revision) return { ok: false, detail: `git resolved an empty base for ${baseRef}` }
    const changed = await this.run(detection.root, [
      'diff', '--name-status', '-z', '-M', '-C', revision,
      '--', FileChangesVcsGit.pathspecOf(detection),
    ])
    if (!FileChangesVcsGit.succeeded(changed))
      return { ok: false, detail: this.detailOf(changed) }
    const [againstBase, porcelain] = await Promise.all([
      this.parseNameStatus(detection, changed.stdout),
      this.status(detection),
    ])
    if (!porcelain.ok) return porcelain
    return {
      ok: true,
      value: {
        revision,
        entries: FileChangesVcsGit.mergeAgainstBase(againstBase, porcelain.value.entries),
        externalRoots: [],
      },
    }
  }

  /**
   * Untracked files count as dirt, which is the parity the Finish label used to get from
   * `GitMergeManager.mergeStatus`. `normal` rather than `all`, because one entry per untracked
   * DIRECTORY already proves the answer and walking into it cannot change it.
   */
  async dirty(detection: FileChangesVcsDetection): Promise<FileChangesVcsResult<boolean>> {
    const outcome = await this.run(detection.root, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=normal',
      '--ignored=no',
      '--',
      FileChangesVcsGit.pathspecOf(detection),
    ])
    if (!FileChangesVcsGit.succeeded(outcome))
      return { ok: false, detail: this.detailOf(outcome) }
    return { ok: true, value: outcome.stdout.length > 0 }
  }

  async history(
    detection: FileChangesVcsDetection,
    limit: number,
  ): Promise<FileChangesVcsResult<readonly FileChangesVcsHistoryGroup[]>> {
    const outcome = await this.run(detection.root, [
      'log',
      `-n${Math.max(1, limit)}`,
      '--format=%x1e%H%x00%an%x00%aI%x00%B%x00',
      '--',
      FileChangesVcsGit.pathspecOf(detection),
    ])
    if (!FileChangesVcsGit.succeeded(outcome))
      return { ok: false, detail: this.detailOf(outcome) }
    const headers = FileChangesVcsGit.parseHistoryHeaders(outcome.stdout)
    const skipped: string[] = []
    // Bounded, because one commit was one child process and the limit is a hundred: a hundred
    // concurrent spawns in the main process, which answers nothing else while they run.
    const groups = await BoundedMap.run(headers, FileChangesLimits.historyConcurrency, async (header) => {
      const changes = await this.run(detection.root, [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-z',
        '-M',
        '-C',
        header.hash,
        '--',
        detection.scopeRelativePath,
      ])
      // Per commit, not per call. Throwing from inside the fan-out discarded the other ninety-nine
      // commits for one that could not be read, and this method's own contract returns a result on
      // failure rather than throwing - `status` and `dirty` beside it both do.
      if (!FileChangesVcsGit.succeeded(changes)) {
        skipped.push(header.hash.slice(0, 12))
        return null
      }
      return {
        id: header.hash,
        revision: header.hash,
        label: header.hash.slice(0, 12),
        author: header.author || null,
        message: header.message || null,
        createdAt: header.createdAt,
        entries: await this.parseNameStatus(detection, changes.stdout),
      } satisfies FileChangesVcsHistoryGroup
    })
    const read = groups.filter((group) => group !== null)
    if (skipped.length > 0 && read.length === 0)
      return { ok: false, detail: `no commit could be read (${skipped.length} skipped)` }
    return { ok: true, value: read }
  }

  async readBaseline(
    detection: FileChangesVcsDetection,
    repositoryPath: string,
    baseline: FileChangesVcsBaselineRef,
  ): Promise<FileChangesVcsContentResult> {
    let revision: string
    if (baseline.kind === 'git-head') revision = baseline.revision
    else if (baseline.kind === 'git-commit') revision = baseline.revision
    else
      throw new Error(`Git cannot read baseline: ${JSON.stringify(baseline)}`)
    const outcome = await this.run(detection.root, [
      'show',
      `${revision}:${FileChangesVcsGit.repositoryPath(repositoryPath)}`,
    ])
    if (FileChangesVcsGit.succeeded(outcome)) return { kind: 'content', content: outcome.stdout }
    const detail = this.detailOf(outcome)
    if (outcome.failure !== null) return { kind: 'unavailable', detail }
    // `missing` means "this path is not in that revision", and the diff then draws the whole file as
    // added. Every other non-zero exit - a repository with no commit yet, a broken object, a
    // rename whose other side was resolved wrong - would be drawn the same way, as a file that never
    // existed. The svn adapter beside this one has always told the two apart; this one now does too.
    return FileChangesVcsGit.missingPathConst.test(detail)
      ? { kind: 'missing', detail }
      : { kind: 'unavailable', detail }
  }

  private async parseStatus(
    detection: FileChangesVcsDetection,
    output: string,
  ): Promise<FileChangesVcsEntry[]> {
    const tokens = output.split('\0')
    const entries: FileChangesVcsEntry[] = []
    for (let index = 0; index < tokens.length;) {
      const token = tokens[index++]
      if (!token) continue
      if (token.length < 4 || token[2] !== ' ')
        throw new Error(`Unknown git status record: ${JSON.stringify(token)}`)
      const gitState = { index: token[0], worktree: token[1] }
      const repositoryPath = FileChangesVcsGit.repositoryPath(token.slice(3))
      const status = FileChangesVcsGit.statusOf(gitState.index, gitState.worktree)
      const hasPrevious = status === 'renamed' || status === 'copied'
      const previousRepositoryPath = hasPrevious
        ? FileChangesVcsGit.repositoryPath(tokens[index++] ?? '')
        : null
      if (hasPrevious && !previousRepositoryPath)
        throw new Error(`Git ${status} record has no previous path`)
      const absolutePath = resolve(detection.root, repositoryPath)
      if (!PathCompare.isInside(detection.cwd, absolutePath))
        throw new Error(`Git returned a path outside its requested scope: ${repositoryPath}`)
      entries.push({
        absolutePath,
        repositoryPath,
        nodeKind: await FileChangesVcsGit.nodeKindOf(absolutePath),
        status,
        previousAbsolutePath: previousRepositoryPath === null
          ? null
          : resolve(detection.root, previousRepositoryPath),
        previousRepositoryPath,
        gitState,
      })
    }
    return entries
  }

  private async parseNameStatus(
    detection: FileChangesVcsDetection,
    output: string,
  ): Promise<FileChangesVcsEntry[]> {
    const tokens = output.split('\0')
    const entries: FileChangesVcsEntry[] = []
    for (let index = 0; index < tokens.length;) {
      const action = (tokens[index++] ?? '').trimStart()
      if (!action) continue
      const previousFirst = action.startsWith('R') || action.startsWith('C')
      const firstPath = FileChangesVcsGit.repositoryPath(tokens[index++] ?? '')
      const repositoryPath = previousFirst
        ? FileChangesVcsGit.repositoryPath(tokens[index++] ?? '')
        : firstPath
      const previousRepositoryPath = previousFirst ? firstPath : null
      if (!repositoryPath)
        throw new Error(`Git history record has no path: ${JSON.stringify(action)}`)
      const absolutePath = resolve(detection.root, repositoryPath)
      if (!PathCompare.isInside(detection.cwd, absolutePath))
        throw new Error(`Git history returned a path outside its requested scope: ${repositoryPath}`)
      entries.push({
        absolutePath,
        repositoryPath,
        nodeKind: await FileChangesVcsGit.nodeKindOf(absolutePath),
        status: FileChangesVcsGit.historyStatusOf(action),
        previousAbsolutePath: previousRepositoryPath === null
          ? null
          : resolve(detection.root, previousRepositoryPath),
        previousRepositoryPath,
        gitState: null,
      })
    }
    return entries
  }

  /**
   * `git log` prints `\x1e<hash>\0<author>\0<date>\0<message>\n\0\n` per commit, so
   * the newline between two records sits at the END of the first one and a record never begins
   * with one. Checked against real output rather than assumed: a leading-newline strip lived here
   * and could not fire.
   */
  private static parseHistoryHeaders(output: string): GitHistoryHeader[] {
    return output.split('\x1e').flatMap((record) => {
      if (!record.trim()) return []
      const [hash, author, created, message] = record.split('\0')
      const createdAt = Date.parse(created ?? '')
      if (!hash || Number.isNaN(createdAt))
        throw new Error(`Unknown git history record: ${JSON.stringify(record)}`)
      return [{ hash, author: author ?? '', createdAt, message: (message ?? '').trim() }]
    })
  }

  private static statusOf(index: string, worktree: string): FileChangeStatus {
    if (index === '?' && worktree === '?') return 'untracked'
    if (index === 'U' || worktree === 'U'
      || (index === 'A' && worktree === 'A')
      || (index === 'D' && worktree === 'D'))
      return 'conflicted'
    if (index === 'R' || worktree === 'R') return 'renamed'
    if (index === 'C' || worktree === 'C') return 'copied'
    if (index === 'T' || worktree === 'T') return 'replaced'
    if (index === 'A' || worktree === 'A') return 'added'
    if (index === 'D' || worktree === 'D') return 'deleted'
    if (index === 'M' || worktree === 'M') return 'modified'
    throw new Error(`Unknown git status: ${JSON.stringify(`${index}${worktree}`)}`)
  }

  private static historyStatusOf(action: string): FileChangeStatus {
    const kind = action[0]
    if (kind === 'A') return 'added'
    else if (kind === 'M') return 'modified'
    else if (kind === 'D') return 'deleted'
    else if (kind === 'R') return 'renamed'
    else if (kind === 'C') return 'copied'
    else if (kind === 'T') return 'replaced'
    else if (kind === 'U') return 'conflicted'
    else
      throw new Error(`Unknown git history status: ${JSON.stringify(action)}`)
  }

  private static mergeAgainstBase(
    againstBase: readonly FileChangesVcsEntry[],
    porcelain: readonly FileChangesVcsEntry[],
  ): readonly FileChangesVcsEntry[] {
    const byPath = new Map(againstBase.map((entry) => [
      PathCompare.comparable(entry.repositoryPath),
      entry,
    ]))
    for (const current of porcelain) {
      const key = PathCompare.comparable(current.repositoryPath)
      const base = byPath.get(key)
      if (base === undefined) {
        if (current.status === 'untracked' || current.status === 'conflicted')
          byPath.set(key, current)
        continue
      }
      byPath.set(key, {
        ...base,
        nodeKind: current.nodeKind,
        status: current.status === 'conflicted' || current.status === 'untracked'
          ? current.status
          : base.status,
        gitState: current.gitState,
      })
    }
    return [...byPath.values()]
  }

  private run(cwd: string, args: string[]): Promise<GitCommandOutcome> {
    return this.runner.run(cwd, [...this.commandArgs, ...args])
  }

  /** The one thing git says that svn does not, so the base's sentence is not the whole answer. */
  protected override detailOf(outcome: GitCommandOutcome): string {
    if (outcome.failure === 'output-limit')
      return 'git printed more than this reader accepts'
    // Cut, because this ends up in a warning the renderer draws in one paragraph, and the output it
    // reads from is capped in megabytes rather than characters.
    return super.detailOf(outcome)
  }
}
