import type {
  OrphanInfo,
  SessionInfo,
  SessionsSnapshot,
} from './sessionManagerApi.types'
import { JsonShape } from '../shared/jsonShape'

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
export class SessionsSnapshotValidation {
  static parse(value: unknown): SessionsSnapshot | null {
    const snapshot = JsonShape.record(value)
    if (snapshot === null
      || !Number.isSafeInteger(snapshot.revision)
      || typeof snapshot.reconciled !== 'boolean'
      || !SessionsSnapshotValidation.host(snapshot.host)
      || !SessionsSnapshotValidation.every(snapshot.categories, SessionsSnapshotValidation.category)
      || !SessionsSnapshotValidation.every(snapshot.sessions, SessionsSnapshotValidation.session)
      || !SessionsSnapshotValidation.every(snapshot.orphans, SessionsSnapshotValidation.orphan))
      return null
    return value as SessionsSnapshot
  }

  private static host(value: unknown): boolean {
    const host = JsonShape.record(value)
    return host !== null
      && (host.presence === 'running'
        || host.presence === 'starting'
        || host.presence === 'unreachable')
      && SessionsSnapshotValidation.optionalText(host.hostVersion)
      && SessionsSnapshotValidation.optionalText(host.hostInstanceId)
      && Number.isSafeInteger(host.liveCount)
      && SessionsSnapshotValidation.optionalText(host.lastStartError)
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
      && SessionsSnapshotValidation.titleParts(session.titleParts)
      && SessionsSnapshotValidation.directory(session.directory)
      && SessionsSnapshotValidation.project(session.project)
      && SessionsSnapshotValidation.life(session.life)
      && SessionsSnapshotValidation.activity(session.activity)
      && SessionsSnapshotValidation.activityDetail(session.activity, session.activityDetail)
      && SessionsSnapshotValidation.worktree(session.worktree)
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
      && SessionsSnapshotValidation.optionalText(parts.number)
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
      || !SessionsSnapshotValidation.filledText(worktree.worktreePath)
      || !SessionsSnapshotValidation.filledText(worktree.branch)
      || !SessionsSnapshotValidation.filledText(worktree.baseCommit)
      || typeof worktree.baseMoved !== 'boolean')
      return false
    if (worktree.diff === null) return true
    const diff = JsonShape.record(worktree.diff)
    return diff !== null
      && SessionsSnapshotValidation.nonNegativeInteger(diff.added)
      && SessionsSnapshotValidation.nonNegativeInteger(diff.removed)
      && SessionsSnapshotValidation.nonNegativeInteger(diff.changedFiles)
      && SessionsSnapshotValidation.nonNegativeInteger(diff.capturedAt)
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
