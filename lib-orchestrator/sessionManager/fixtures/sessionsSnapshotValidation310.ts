/*
 * The snapshot validator of Jamat 3.10.0 as it shipped (git 7f1bac7), kept as a test fixture: a peer on
 * that build still validates what this one composes. Retire it once 3.10 is no supported peer.
 */
import type {
  OrphanInfo,
  SessionInfo,
  SessionsSnapshot,
  SvnFinishResult,
} from '../sessionManagerApi.types'
import { JsonShape } from '../../shared/jsonShape'

/**
 * A sessions snapshot that arrived from somewhere this process does not own.
 *
 * There is exactly one such place: what another computer answers to `sessions.list` over the peer
 * channel. Everything else builds a snapshot locally, where the types hold. Until 2026-08-23 the
 * remote one was accepted after six checks and an assertion for the rest, so `sessions: [null]` from
 * a paired peer reached the tree and threw where it was drawn.
 *
 * MANDATORY fields only, and deliberately: an optional field that is absent means the same thing
 * whether the snapshot is local or remote, and every surface already reads it as absent. What has to
 * hold is that each element IS an object carrying the fields the tree keys on, because those are the
 * reads that throw rather than draw nothing.
 */
export class SessionsSnapshotValidation310 {
  private static readonly finishResultsConst: readonly string[] = ['committed', 'partial', 'not-committed',
    'out-of-date', 'updated', 'conflict', 'nothing', 'failed', 'interrupted'] satisfies readonly SvnFinishResult[]

  static parse(value: unknown): SessionsSnapshot | null {
    const snapshot = JsonShape.record(value)
    if (snapshot === null
      || !Number.isSafeInteger(snapshot.revision)
      || typeof snapshot.reconciled !== 'boolean'
      || !SessionsSnapshotValidation310.host(snapshot.host)
      || !SessionsSnapshotValidation310.every(snapshot.categories, SessionsSnapshotValidation310.category)
      || !SessionsSnapshotValidation310.every(snapshot.sessions, SessionsSnapshotValidation310.session)
      || !SessionsSnapshotValidation310.every(snapshot.orphans, SessionsSnapshotValidation310.orphan))
      return null
    const parsed = value as SessionsSnapshot
    // A peer older than SVN worktrees sends no kind, and every worktree it has is a Git one. Nor
    // does it send the Finish choices, which its library composed by kind alone.
    for (const session of parsed.sessions) {
      if (session.worktree === undefined) continue
      if (session.worktree.kind === undefined) session.worktree.kind = 'git'
      if (session.worktree.choices === undefined)
        session.worktree.choices = session.worktree.kind === 'svn'
          ? ['commit', 'keep', 'discard']
          : ['merge', 'keep', 'discard']
    }
    return parsed
  }

  private static host(value: unknown): boolean {
    const host = JsonShape.record(value)
    return host !== null
      && (host.presence === 'running'
        || host.presence === 'starting'
        || host.presence === 'unreachable')
      && SessionsSnapshotValidation310.optionalText(host.hostVersion)
      && SessionsSnapshotValidation310.optionalText(host.hostInstanceId)
      && Number.isSafeInteger(host.liveCount)
      && SessionsSnapshotValidation310.optionalText(host.lastStartError)
  }

  private static category(value: unknown): boolean {
    const category = JsonShape.record(value)
    return category !== null
      && typeof category.id === 'string'
      && typeof category.label === 'string'
      && typeof category.path === 'string'
  }

  private static session(value: unknown): value is SessionInfo {
    const session = JsonShape.record(value)
    return session !== null
      && typeof session.sessionId === 'string'
      && (session.kind === 'shell' || session.kind === 'agent')
      && typeof session.title === 'string'
      && typeof session.tabTitle === 'string'
      && SessionsSnapshotValidation310.titleParts(session.titleParts)
      && SessionsSnapshotValidation310.directory(session.directory)
      && SessionsSnapshotValidation310.project(session.project)
      && SessionsSnapshotValidation310.life(session.life)
      && SessionsSnapshotValidation310.activity(session.activity)
      && SessionsSnapshotValidation310.activityDetail(session.activity, session.activityDetail)
      && (session.compacting === undefined || (session.compacting === true
        && session.activity === 'working' && session.activityDetail === undefined))
      && SessionsSnapshotValidation310.worktree(session.worktree)
      && SessionsSnapshotValidation310.retiredWorktree(session.retiredWorktree)
      && Array.isArray(session.admits)
      && session.admits.every((operation) => typeof operation === 'string')
    // `outputSeq` and `lastOutputAt` were checked here until 2026-08-24 and left `SessionInfo` in
    // the same change. A peer on an older build still sends them; they are simply not read, which
    // is what keeps this validator from refusing a snapshot for carrying a field it once required.
  }

  private static orphan(value: unknown): value is OrphanInfo {
    const orphan = JsonShape.record(value)
    return orphan !== null
      && typeof orphan.runtimeSessionId === 'string'
      && typeof orphan.alive === 'boolean'
      && Number.isSafeInteger(orphan.startedAt)
  }

  private static titleParts(value: unknown): boolean {
    const parts = JsonShape.record(value)
    return parts !== null
      && SessionsSnapshotValidation310.optionalText(parts.number)
      && typeof parts.name === 'string'
  }

  private static directory(value: unknown): boolean {
    const directory = JsonShape.record(value)
    if (directory === null) return false
    else if (directory.mode === 'project')
      return typeof directory.categoryId === 'string' && typeof directory.projectPath === 'string'
    else if (directory.mode === 'adHoc') return typeof directory.path === 'string'
    else if (directory.mode === 'default') return true
    else return false
  }

  private static project(value: unknown): boolean {
    const project = JsonShape.record(value)
    if (project === null) return false
    else if (project.kind === 'project')
      return typeof project.categoryId === 'string'
        && typeof project.projectName === 'string'
        && typeof project.projectPath === 'string'
    else if (project.kind === 'adHoc') return typeof project.path === 'string'
    else if (project.kind === 'none') return true
    else return false
  }

  private static life(value: unknown): boolean {
    return value === 'starting' || value === 'live' || value === 'ended' || value === 'lost'
  }

  private static activity(value: unknown): boolean {
    return value === null
      || value === 'working'
      || value === 'waiting'
      || value === 'idle'
      || value === 'unknown'
  }

  private static activityDetail(activity: unknown, detail: unknown): boolean {
    return detail === undefined || (activity === 'working' && detail === 'background')
  }

  private static worktree(value: unknown): boolean {
    if (value === undefined) return true
    const worktree = JsonShape.record(value)
    if (worktree === null
      || !SessionsSnapshotValidation310.filledText(worktree.worktreePath)
      || !SessionsSnapshotValidation310.filledText(worktree.branch)
      || !SessionsSnapshotValidation310.filledText(worktree.baseCommit)
      || typeof worktree.baseMoved !== 'boolean'
      || (worktree.kind !== undefined && worktree.kind !== 'svn' && worktree.kind !== 'git')
      || (worktree.choices !== undefined
        && !SessionsSnapshotValidation310.every(worktree.choices, SessionsSnapshotValidation310.finishChoice))
      || !SessionsSnapshotValidation310.worktreeFinish(worktree.finish)
      || !SessionsSnapshotValidation310.worktreeOutcome(worktree.outcome)
      || !SessionsSnapshotValidation310.worktreeCleanup(worktree.cleanup))
      return false
    if (worktree.diff === null) return true
    const diff = JsonShape.record(worktree.diff)
    return diff !== null
      && SessionsSnapshotValidation310.nonNegativeInteger(diff.added)
      && SessionsSnapshotValidation310.nonNegativeInteger(diff.removed)
      && SessionsSnapshotValidation310.nonNegativeInteger(diff.changedFiles)
      && SessionsSnapshotValidation310.nonNegativeInteger(diff.capturedAt)
  }

  private static finishChoice(value: unknown): boolean {
    return value === 'commit' || value === 'merge' || value === 'keep' || value === 'discard'
  }

  /** The tree draws a badge per phase and per result, and a value it does not know throws there. */
  private static worktreeFinish(value: unknown): boolean {
    if (value === undefined) return true
    const finish = JsonShape.record(value)
    return finish !== null
      && (finish.phase === 'updating' || finish.phase === 'reviewing'
        || finish.phase === 'main-updating' || finish.phase === 'removing')
      && (finish.scopeRoot === undefined || typeof finish.scopeRoot === 'string')
  }

  private static worktreeOutcome(value: unknown): boolean {
    if (value === undefined) return true
    const outcome = JsonShape.record(value)
    return outcome !== null
      && SessionsSnapshotValidation310.finishResultsConst.includes(outcome.result as string)
      && SessionsSnapshotValidation310.every(outcome.revisions, (revision) => typeof revision === 'string')
      && typeof outcome.main === 'string'
      && (outcome.worktree === 'removed' || outcome.worktree === 'kept'
        || outcome.worktree === 'in-use' || outcome.worktree === 'undeleted')
      && SessionsSnapshotValidation310.every(outcome.lines, (line) => typeof line === 'string')
      && typeof outcome.at === 'number'
  }

  private static worktreeCleanup(value: unknown): boolean {
    if (value === undefined) return true
    const cleanup = JsonShape.record(value)
    return cleanup !== null
      && (cleanup.phase === 'pending' || cleanup.phase === 'kept')
      && (cleanup.reason === undefined || typeof cleanup.reason === 'string')
      && typeof cleanup.summary === 'string'
  }

  private static retiredWorktree(value: unknown): boolean {
    if (value === undefined) return true
    const retired = JsonShape.record(value)
    return retired !== null
      && SessionsSnapshotValidation310.filledText(retired.worktreePath)
      && SessionsSnapshotValidation310.every(retired.revisions, (revision) => typeof revision === 'string')
  }

  private static every(value: unknown, holds: (item: unknown) => boolean): boolean {
    return Array.isArray(value) && value.every((item) => holds(item))
  }

  private static optionalText(value: unknown): boolean {
    return value === null || typeof value === 'string'
  }

  private static nonNegativeInteger(value: unknown): boolean {
    return Number.isSafeInteger(value) && (value as number) >= 0
  }

  private static filledText(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0
  }

}
