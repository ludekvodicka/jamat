import type {
  FileChangeBaselineKind,
  FileChangeGitState,
  FileChangeNodeKind,
  FileChangeStatus,
  FileChangesVcsDetection,
  FileChangesVcsId,
  FileChangesVcsResult,
} from '../fileChangesManagerApi.types'

export interface FileChangesVcsEntry {
  absolutePath: string
  repositoryPath: string
  nodeKind: FileChangeNodeKind
  status: FileChangeStatus
  previousAbsolutePath: string | null
  previousRepositoryPath: string | null
  gitState: FileChangeGitState | null
}

export interface FileChangesVcsHistoryGroup {
  id: string
  revision: string
  label: string
  author: string | null
  message: string | null
  createdAt: number
  entries: readonly FileChangesVcsEntry[]
}

export interface FileChangesVcsStatus {
  entries: readonly FileChangesVcsEntry[]
  externalRoots: readonly string[]
}

/**
 * Which revision of a file a diff is against.
 *
 * The `kind` is the wire's own union minus the one no VCS mints, rather than four members written
 * out again: they were kept in step by two parallel literals in one branch, so a fifth baseline kind
 * would have compiled here and failed at runtime.
 */
export interface FileChangesVcsBaselineRef {
  kind: Exclude<FileChangeBaselineKind, 'chat-message'>
  revision: string
}

export type FileChangesVcsContentResult =
  | { kind: 'content'; content: string }
  | { kind: 'missing'; detail: string }
  | { kind: 'unavailable'; detail: string }

export interface FileChangesVcs {
  readonly id: FileChangesVcsId
  /**
   * What this tool calls "the working copy's own baseline" - `HEAD` for git, `BASE` for svn - and
   * what it calls one point in its history.
   *
   * Asked of the adapter because it is knowledge the adapter has about itself. Branching on
   * `adapter.id` in the manager meant a third VCS was four files to edit with only a runtime throw
   * to catch a miss.
   */
  readonly defaultBaselineRef: FileChangesVcsBaselineRef
  historyBaselineRef(revision: string): FileChangesVcsBaselineRef
  detect(cwd: string): Promise<FileChangesVcsDetection | null>
  status(detection: FileChangesVcsDetection): Promise<FileChangesVcsResult<FileChangesVcsStatus>>
  /** One cheap question - is the scope dirty - without parsing per-file entries. */
  dirty(detection: FileChangesVcsDetection): Promise<FileChangesVcsResult<boolean>>
  history(
    detection: FileChangesVcsDetection,
    limit: number,
  ): Promise<FileChangesVcsResult<readonly FileChangesVcsHistoryGroup[]>>
  readBaseline(
    detection: FileChangesVcsDetection,
    repositoryPath: string,
    baseline: FileChangesVcsBaselineRef,
  ): Promise<FileChangesVcsContentResult>
}
