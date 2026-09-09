export type FileChangesAgentId = 'claude' | 'codex'
export type FileChangesVcsId = 'git' | 'svn'
export type FileChangesWorkingTreeSource = 'checkpoint' | 'svn' | 'worktree-base'
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'replaced'
  | 'untracked'
  | 'conflicted'
  | 'missing'
  | 'obstructed'
export type FileChangeLocation = 'workspace' | 'external'
export type FileChangeNodeKind = 'file' | 'directory'
export type FileChangeSource = 'vcs' | 'chat'
export type FileHistoryCompleteness = 'full' | 'region' | 'unavailable'

export interface FileChangesContext {
  sessionId: string
  cwd: string
  agent: { agentId: FileChangesAgentId; nativeSessionId: string } | null
}

export interface FileChangesWorkingTreeContext extends FileChangesContext {
  worktree: {
    worktreePath: string
    repositoryRoot: string
    baseCommit: string
  } | null
}

export interface FileChangesListOptions {
  preferredVcs?: FileChangesVcsId
  historyPageSize?: number
}

export interface FileChangesVcsSelection {
  requested: FileChangesVcsId
  selected: FileChangesVcsId | null
  available: readonly FileChangesVcsId[]
  root: string | null
  fallbackReason: string | null
}

export interface FileChangeGitState {
  index: string
  worktree: string
}

export interface FileChangeEntry {
  fileId: string
  path: string
  displayPath: string
  nodeKind: FileChangeNodeKind
  location: FileChangeLocation
  status: FileChangeStatus
  /** Absolute, the way `path` is: what the file was called before it moved. */
  previousPath: string | null
  /**
   * The same fact as `previousPath`, spelled the way `displayPath` is - relative to the session cwd
   * where it sits inside it. A rename row draws both, and it drew one absolute path against one
   * relative one: `Q:\proj\src\old.ts -> src/new.ts` for a plain `git mv src/old.ts src/new.ts`.
   */
  previousDisplayPath: string | null
  /** Working-tree mtime; null when the path is gone or the entry belongs to a past group. */
  modifiedAt: number | null
  sources: readonly FileChangeSource[]
  gitState: FileChangeGitState | null
}

export type FileChangeBaselineKind =
  | 'git-head'
  | 'svn-base'
  | 'git-commit'
  | 'svn-revision'
  | 'chat-message'

export interface FileChangeBaseline {
  baselineId: string
  kind: FileChangeBaselineKind
  label: string
  revision: string | null
  createdAt: number | null
}

export interface FileChangeGroup {
  groupId: string
  /** What the group is - a commit, a revision, a chat message - is `baseline.kind`, and only there. */
  baseline: FileChangeBaseline
  label: string
  message: string | null
  author: string | null
  createdAt: number
  entries: readonly FileChangeEntry[]
}

export interface FileChangesHistoryPage {
  groups: readonly FileChangeGroup[]
  nextCursor: string | null
}

export interface FileChangesSnapshot {
  snapshotId: string
  sessionId: string
  createdAt: number
  vcs: FileChangesVcsSelection
  defaultBaseline: FileChangeBaseline | null
  entries: readonly FileChangeEntry[]
  history: FileChangesHistoryPage
  warnings: readonly string[]
}

export interface FileChangesWorkingTreeSelection {
  requested: FileChangesWorkingTreeSource | null
  selected: FileChangesWorkingTreeSource | null
  available: readonly FileChangesWorkingTreeSource[]
  fallbackReason: string | null
}

export interface FileChangesWorkingTreeSnapshot {
  snapshotId: string
  sessionId: string
  createdAt: number
  source: FileChangesWorkingTreeSelection
  defaultBaseline: FileChangeBaseline | null
  entries: readonly FileChangeEntry[]
  warnings: readonly string[]
}

export type FileChangesWorkingTreeSnapshotResult =
  | { ok: true; value: FileChangesWorkingTreeSnapshot }
  | { ok: false; code: 'invalid-context'; detail: string }

export type FileChangesSnapshotResult =
  | { ok: true; value: FileChangesSnapshot }
  | { ok: false; code: 'invalid-context'; detail: string }

export type FileChangesHistoryResult =
  | { ok: true; value: FileChangesHistoryPage }
  | { ok: false; code: 'snapshot-expired' | 'invalid-cursor'; detail: string }

export interface FileDiffRequest {
  snapshotId: string
  fileId: string
  baselineId: string
}

export type FileTextEol = 'none' | 'lf' | 'crlf' | 'mixed'

export interface FileDiffVersion {
  label: string
  path: string
  exists: boolean
  eol: FileTextEol
  finalNewline: boolean | null
}

export type FileDiffLineKind = 'context' | 'add' | 'remove'

export interface FileDiffLine {
  kind: FileDiffLineKind
  text: string
  beforeLine: number | null
  afterLine: number | null
}

export interface FileDiffHunk {
  beforeStart: number
  beforeLines: number
  afterStart: number
  afterLines: number
  lines: readonly FileDiffLine[]
}

export interface FileDiffData {
  status: FileChangeStatus
  completeness: Exclude<FileHistoryCompleteness, 'unavailable'>
  current: FileDiffVersion
  baseline: FileDiffVersion
  hunks: readonly FileDiffHunk[]
  detail: string | null
}

export type FileDiffUnavailableKind =
  | 'binary'
  | 'too-large'
  | 'too-complex'
  | 'busy'
  | 'missing'
  | 'incomplete-history'
  | 'source-unavailable'

export type FileDiffResult =
  | { ok: true; kind: 'text'; data: FileDiffData }
  | { ok: true; kind: FileDiffUnavailableKind; detail: string }
  | {
    ok: false
    code: 'snapshot-expired' | 'unknown-file' | 'unknown-baseline' | 'invalid-pair'
    detail: string
  }

/**
 * What kind of working copy governs a directory, and where its scope sits inside it.
 *
 * On the subsystem ROOT rather than inside `vcs/`, because `VcsStatusView` hands it out and takes it
 * back: any consumer that reads through that view has to be able to name it. While it lived in
 * `vcs/fileChangesVcs.types.ts`, the one thing the view exists to prevent - another subsystem
 * importing this one's internals - was exactly what `vcsFacts` had to do to use it.
 */
export interface FileChangesVcsDetection {
  id: FileChangesVcsId
  root: string
  cwd: string
  scopeRelativePath: string
  scopeUrl: string | null
  repositoryPathPrefix: string | null
}

/**
 * What a VCS read answers with. On the root beside `FileChangesVcsDetection` and for the same
 * reason: `VcsStatusView.dirty` returns it, so a consumer reading through that view has to be able
 * to name it without reaching into `vcs/`.
 */
export type FileChangesVcsResult<T> =
  | { ok: true; value: T }
  | { ok: false; detail: string }
