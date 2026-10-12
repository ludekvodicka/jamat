export type SvnErrorCode =
  | 'svn-missing'
  | 'not-a-working-copy'
  | 'out-of-date'
  | 'locked'
  | 'external-target'
  | 'svn-failed'
  /** A rule of the worktree contract refuses the request; nothing was changed. */
  | 'refused'
  /** A disk operation outside svn failed. */
  | 'io-failed'

export type SvnResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SvnErrorCode; detail: string }

/** The `item` attribute of `<wc-status>`, every value svn 1.14 writes. */
export type SvnWcItem =
  | 'added'
  | 'conflicted'
  | 'deleted'
  | 'external'
  | 'ignored'
  | 'incomplete'
  | 'merged'
  | 'missing'
  | 'modified'
  | 'none'
  | 'normal'
  | 'obstructed'
  | 'replaced'
  | 'unversioned'

/** The `props` attribute of `<wc-status>`. */
export type SvnWcProps = 'none' | 'normal' | 'modified' | 'conflicted'

/**
 * What a worktree finish makes of one status entry: `item` a content, add, delete or unversioned
 * change, `props` a change of properties only, `missing` deleted from disk, `external` a mount.
 */
export type SvnStatusKind = 'clean' | 'item' | 'props' | 'missing' | 'external'

export interface SvnStatusRow {
  kind: SvnStatusKind
  /** A text, property or tree conflict. */
  conflict: boolean
  /** Relative to the root the status was read for, with `/`; the root itself is `.`. */
  path: string
}

/** One entry of `svn status -v --xml`. */
export interface SvnVerboseItem {
  path: string
  item: SvnWcItem
  props: SvnWcProps
  /** BASE revision, 0 when unversioned. */
  base: number
  /** Last-changed revision, 0 when unversioned. */
  changed: number
}

export type SvnLogAction = 'A' | 'D' | 'M' | 'R'

/** One path a revision changed, relative to the worktree (`.` the worktree or mount root). */
export interface SvnLoggedRow {
  revision: number
  action: SvnLogAction
  path: string
}

/**
 * How a changed path names its project: `whole` the worktree is one project, `first-segment` a
 * product group whose member project is the first path segment.
 */
export type SvnGroupMembers = 'whole' | 'first-segment'

/** One entry of `svn info --xml`. */
export interface SvnInfoEntry {
  path: string
  kind: 'file' | 'dir'
  revision: number
  url: string
  repository: string
  /** The repository path the entry checks out, decoded, without `^` and a trailing `/`. */
  base: string
}

/** The BASE proof of what a review committed when it gave no receipt. */
export interface SvnProofInput {
  /** `status -v` of the root, placed in the worktree. */
  items: readonly SvnVerboseItem[]
  /** The root's place in the worktree, `''` for the worktree itself. */
  own: string
  /** The BASE the update gave the root. */
  rootBase: number
  /** The youngest revision of the repository before the review. */
  since: number
  /** The changed paths of this root, worktree-relative. */
  claimed: readonly string[]
  /** Paths changed after `since` below the root's URL, placed. */
  history(): Promise<SvnLoggedRow[]>
  /** Paths one revision changed below the root's URL, placed. */
  revisionLog(revision: number): Promise<SvnLoggedRow[]>
}

/** The receipt of a review: one revision, confirmed by the log. */
export interface SvnReceiptInput {
  revision: number
  since: number
  /** The repository path the root checks out, for the refusal. */
  base: string
  revisionLog(revision: number): Promise<SvnLoggedRow[]>
}

/** This working copy's own commits since its checkout: clean items whose BASE is their last change. */
export interface SvnOwnCommitInput {
  items: readonly SvnVerboseItem[]
  revisionLog(revision: number): Promise<SvnLoggedRow[]>
}

export interface SvnAttribution {
  committed: string[]
  remaining: string[]
  /** The revisions that hold a committed path, ascending. */
  revisions: number[]
}

/** An SVN worktree as its session record names it. */
export interface SvnWorktreeLocation {
  worktreePath: string
  /** The directory the worktree was checked out from: the main copy. */
  ownerDir: string
  /** The URL the worktree checks out, which is the owner's URL. */
  url: string
  /** `dev:ino:birthtimeNs` at checkout; absent where the file system gives no file ID. */
  directoryId?: string
}

/** A reserved worktree folder and what its checkout takes: the owner's URL at the HEAD read at the reservation. */
export interface SvnCheckout {
  worktreePath: string
  url: string
  baseRevision: number
  /** null where the file system gives no file ID. */
  directoryId: string | null
}

/** A working copy a finish reviews on its own: an external mount, or the worktree itself. */
export interface SvnRoot {
  /** Absolute directory. */
  path: string
  /** Its place in the worktree: `''` for the worktree itself, else the mount path. */
  own: string
  /** The changed rows whose innermost working copy this is, worktree-relative. */
  changed: SvnStatusRow[]
}

/** One conflicted path after an update: a text conflict a resolver may settle, or a tree or property conflict. */
export interface SvnConflictRow {
  path: string
  text: boolean
  /** A tree or property conflict, which always needs the person. */
  other: boolean
}

/** A worktree's state after an update, read from status XML. */
export interface SvnWorktreeStatus {
  textConflicts: string[]
  otherConflicts: string[]
  /** Every changed path, mounts included, worktree-relative. */
  changed: string[]
}

/** A root to review: `pinned` an external whose definition names a revision, which no review may commit. */
export interface SvnReviewRoot extends SvnRoot {
  pinned: boolean
}

/** What a proof needs of one root, read before its review. */
export interface SvnRootBounds {
  /** Repository root URL. */
  repository: string
  /** The repository path the root checks out. */
  base: string
  /** The BASE the update gave the root. */
  rootBase: number
  /** The youngest revision of the repository before any review. */
  since: number
}

/** By `SvnRoot.own`. */
export type SvnBounds = Readonly<Record<string, SvnRootBounds>>

export interface SvnWorktreeFacts {
  added: number
  removed: number
  changedFiles: number
}
