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

export interface SvnRemovalRow extends SvnStatusRow {
  ignored: boolean
}

export interface SvnStatusRow {
  deleted?: true
  /** Not under version control and not scheduled for addition (`?`). */
  unversioned?: true
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

export interface SvnLandingPath extends SvnLoggedRow {
  repository: string
  repositoryPath: string
  root: string | null
}

export interface SvnLandingReceipt { repository: string; revision: number; paths?: readonly string[] }

/** A local state of a working-copy node that an update leaves as it is. */
export type SvnLocalItem = Exclude<SvnWcItem, 'normal' | 'modified' | 'none' | 'missing' | 'incomplete'>

/** The person's local state of a landed path in the main copy, by its path below the main copy. */
export interface SvnLandingLocal { path: string; item: SvnLocalItem }

/** `local` is present when the person's own state of the first unproven path, not the distance to HEAD, keeps the landing unproven. */
export interface SvnLandingProof { holds: boolean; reason?: string; local?: SvnLandingLocal }

/** One commit as `svn log --xml` names it, for a brief that says what the other side did. */
export interface SvnLogEntry {
  revision: number
  /** null when svn names none (an anonymous commit). */
  author: string | null
  message: string
}

export interface SvnCommitHistory extends SvnLogEntry {
  date: number
  paths: string[]
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
  /** Called before each candidate's `svn log -v`, so a caller can say which of how many it reads. */
  onRevision?: (revision: number, index: number, count: number) => void
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

/** How many revisions of its own repository changed one working-copy root after its revision. */
export interface SvnBehindRoot {
  /** `SvnRoot.own`: `''` for the main copy itself, else the mount path. */
  own: string
  behind: number
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

/** svn's own kinds; `diverged` is Jamat's: a same-name file that keep-both left for a merge. */
export type SvnConflictKind = 'text' | 'property' | 'tree' | 'diverged'
/** svn's `reason` word of a tree conflict (`edit`, `obstruction`, ...), in Jamat's words. */
export type SvnTreeReason = 'edited' | 'obstructed' | 'deleted' | 'missing' | 'unversioned' | 'added'
  | 'replaced' | 'moved-away' | 'moved-here' | 'unrecognized'
/** svn's `action` word of a tree conflict (`edit`, `add`, `delete`, `replace`), in Jamat's words. */
export type SvnTreeAction = 'edited' | 'added' | 'deleted' | 'replaced' | 'unrecognized'
export type SvnNodeKind = 'file' | 'dir' | 'none' | 'unrecognized'

export interface SvnTreeFacts {
  /** Older records describe update conflicts. A merge does not install its incoming tree into BASE. */
  operation?: 'merge'
  reason: SvnTreeReason
  action: SvnTreeAction
  /** The `kind` of `<tree-conflict>`: the node in the working copy. */
  localKind: SvnNodeKind
  /** The `kind` of `<version side="source-right">`; `none` for an incoming delete. */
  incomingKind: SvnNodeKind
  /** source-right: the revision the update brought. */
  incomingRevision: number | null
  /** source-left: the revision before this unresolved conflict, even after the working copy advances. */
  baseRevision?: number
  /** The local add has history (copy or move), so no rule may revert it. */
  localHistory: boolean
  /**
   * Where the moved node lives now, worktree-relative: the session's move target (`<moved-to>` of a
   * `moved-away` victim) or, for an incoming delete, the place the other commits moved it to.
   */
  movedTo?: string
}

export interface SvnContentFacts {
  binary: boolean
  unreadable: boolean
  /** Mine against theirs; null when one side is absent. */
  equal: 'bytes' | 'eol' | 'differs' | null
  /**
   * Differing readable text, merged three ways against the side before the update with line ends
   * ignored (`SvnTextMerge`): `clean` when no change of one side overlaps the other's. Absent
   * without the older side.
   */
  merge?: 'clean' | 'conflict'
  /** A directory obstruction: files on each side, and same-name files equal or not. */
  files?: { local: number; incoming: number; same: number; differing: number }
}

/** A property whose value before the update, in the working copy and in the new BASE all differ. */
export interface SvnPropertyFacts { name: string; older: string | null; mine: string | null; theirs: string | null }

export interface SvnConflictFact {
  /** Worktree-relative with '/'. */
  path: string
  /**
   * The first of tree, text, property that svn marks; `properties` lists the conflicted properties of a tree or
   * property fact. A path svn marks with a text and a property conflict (no tree) is read as two facts, one of
   * each kind, so each is settled by its own choice.
   */
  kind: Exclude<SvnConflictKind, 'diverged'>
  /** false: read and listed, never passed to svn. */
  takesArgument: boolean
  tree: SvnTreeFacts | null
  /** svn's .mine, .r<old>, .r<new> or .prej, root-relative. */
  sidecars: string[]
  properties: SvnPropertyFacts[]
  content: SvnContentFacts | null
  /**
   * The BASE revision of the root of the working copy that holds the path: an external's own, not the
   * worktree's. The incoming revision of a conflict whose tree facts name none.
   */
  rootRevision?: number
}

export type SvnConflictShape =
  | 'text-overlap' | 'text-same' | 'binary' | 'text-unreadable' | 'name-unsafe'
  | 'mergeinfo' | 'line-list-property' | 'property-value' | 'property-unknown' | 'externals'
  | 'obstructed-file' | 'obstructed-dir' | 'added-both' | 'kind-mismatch'
  | 'edit-vs-delete' | 'edit-vs-replace' | 'delete-vs-edit' | 'delete-vs-delete' | 'replace-or-case'
  | 'diverged' | 'drops-incoming' | 'unrecognized'

export type SvnConflictOption = 'merged' | 'take-incoming' | 'keep-mine' | 'keep-both' | 'union'
export type SvnConflictLoss = 'nothing' | 'mine' | 'incoming'

export interface SvnConflictPlan {
  shape: SvnConflictShape
  /** Admitted, in drawing order; empty: fix it outside Jamat, then Check again. */
  options: readonly SvnConflictOption[]
  /** The lossless option the rules apply, only where the facts prove it. */
  rule: SvnConflictOption | null
  agent: boolean
}

/** One named step of an option; `SvnConflictResolutions.stepsOf` lists them per kind and option. */
export type SvnConflictStepName =
  | 'save-local' | 'remove-saved' | 'revert-incoming' | 'put-back' | 'restore-saved'
  | 'save-sidecars' | 'write-merged' | 'no-markers' | 'union-properties'
  | 'accept-working' | 'accept-theirs-full' | 'accept-mine-full' | 'accept-mine-conflict' | 'accept-incoming-move'

/** How far an option got on one path: the first `done` steps ran; a resume starts after them. */
export interface SvnConflictJournal { option: SvnConflictOption; done: number }

/** One option on one conflicted path, as the executor runs it. */
export interface SvnConflictApply {
  actionId?: string
  occurrenceId?: string
  /**
   * keep-both of a move, from the entry's facts: `away` applies the incoming edit to the session's
   * move target, `incoming` applies the session's edit to the place the other commit moved the file to.
   */
  move?: 'away' | 'incoming'
  /** The working copy root; every svn call runs here. */
  root: string
  /** Every copy lands here before svn touches the path; an existing copy is never overwritten. */
  savedDir: string
  /** Root-relative with '/'. */
  path: string
  kind: SvnConflictKind
  option: SvnConflictOption
  /** The conflicted property names, for `union`. */
  properties?: readonly string[]
  /** BASE before the update, for a line list's value before it (`union`). */
  baseRevision?: number
  /**
   * Jamat's `merged` rule on text whose sides merge cleanly (`SvnContentFacts.merge`): the executor
   * writes that merge over svn's markers first. A person's Merged press never sets it, so their own
   * edit of the file is what gets accepted.
   */
  rebuild?: true
  /**
   * The other kind of conflict on this path (text beside property) is still open. svn resolves every
   * kind of a path at once, so the option installs only its own side and leaves svn's mark; the
   * settlement of the other kind resolves both.
   */
  held?: true
  /** The root is a main copy, where no svn cleanup ever runs, not even of Jamat's own interrupted step. */
  mainCopy?: true
  journal: SvnConflictJournal | null
  /** Before the next step starts: the journal so far and the same-name files the step left diverged. */
  onStep(journal: SvnConflictJournal, diverged: readonly string[]): Promise<void>
}

/** One row of status XML with its item state, for the guards. */
export interface SvnItemRow { path: string; item: SvnWcItem; conflict: boolean; base: number }

export interface SvnConflictRead {
  revision: number
  facts: SvnConflictFact[]
  rows: SvnItemRow[]
  /** Working-copy locks from the same status read; older readers provide no lock evidence. */
  lockedPaths?: string[]
}
