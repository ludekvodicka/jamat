import type {
  OrphanInfo,
  SessionInfo,
  SessionScriptId,
  SessionScriptPhase,
  SessionScriptRunInfo,
  SessionScriptRunState,
  SessionScriptsBadge,
  SessionScriptsInfo,
  SessionsSnapshot,
  SvnActionNeed,
  SvnActionStage,
  SvnFinishResult,
} from './sessionManagerApi.types'
import { ScriptBadges } from './scripts/scriptBadges'
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
  private static readonly finishResultsConst: readonly string[] = ['committed', 'partial', 'not-committed',
    'out-of-date', 'updated', 'conflict', 'nothing', 'failed', 'interrupted'] satisfies readonly SvnFinishResult[]
  private static readonly scriptPhasesConst: readonly string[] = ['before', 'after', 'inner'] satisfies readonly SessionScriptPhase[]
  private static readonly scriptIdsConst: readonly string[] =
    ['setup', 'declared', 'merge-resolve', 'requested', 'svn', 'checks', 'svn-resolve', 'review'] satisfies readonly SessionScriptId[]
  private static readonly actionStagesConst: readonly string[] = ['stopping', 'evidence', 'checks', 'updating', 'cleaning',
    'resolving', 'verifying', 'diffing', 'reviewing', 'removing', 'recording'] satisfies readonly SvnActionStage[]
  private static readonly actionNeedsConst: readonly string[] = ['check-failed', 'conflict', 'resolver-failed', 'incoming',
    'out-of-date', 'review-cancelled', 'review-interrupted', 'partial', 'pinned-external', 'locked', 'svn-failed',
    'not-stopped'] satisfies readonly SvnActionNeed[]
  private static readonly runStatesConst: readonly string[] =
    ['running', 'succeeded', 'failed', 'stopped', 'lost'] satisfies readonly SessionScriptRunState[]
  private static readonly badgeStatesConst: readonly string[] =
    ['running', 'failed', 'skipped', 'succeeded'] satisfies readonly SessionScriptsBadge['state'][]

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
    for (const session of parsed.sessions) {
      SessionsSnapshotValidation.scriptsInto(session)
      // Optional and newer than many peers: a value this build cannot draw costs the field, never the session.
      if (session.svnAction !== undefined && !SessionsSnapshotValidation.svnAction(session.svnAction)) delete session.svnAction
      if (session.worktree?.liveFinish !== undefined && session.worktree.liveFinish !== true) delete session.worktree.liveFinish
      if (session.retiredWorktree?.landing !== undefined && !SessionsSnapshotValidation.landing(session.retiredWorktree.landing))
        delete session.retiredWorktree.landing
    }
    return parsed
  }

  private static svnAction(value: unknown): boolean {
    const action = JsonShape.record(value)
    if (action === null || (action.kind !== 'finish' && action.kind !== 'discard' && action.kind !== 'update-main')
      || !SessionsSnapshotValidation.actionStagesConst.includes(action.stage as string)) return false
    if (action.needs !== null && typeof action.needs !== 'string') return false
    if (action.needsKind !== null && !SessionsSnapshotValidation.actionNeedsConst.includes(action.needsKind as string)) return false
    if (action.review === null) return true
    const review = JsonShape.record(action.review)
    return review !== null && Number.isSafeInteger(review.index) && Number.isSafeInteger(review.count)
      && typeof review.scopeRoot === 'string'
  }

  private static landing(value: unknown): boolean {
    const landing = JsonShape.record(value)
    return landing !== null && SessionsSnapshotValidation.filledText(landing.mainCopy)
      && (landing.behind === null || SessionsSnapshotValidation.nonNegativeInteger(landing.behind))
      && SessionsSnapshotValidation.every(landing.newest, (revision) => typeof revision === 'string')
  }

  /**
   * The script fields are optional, so a value this build does not know is dropped rather than the
   * snapshot refused: a newer peer's new phase costs its badge, never the connection. An older peer
   * sends only the legacy fields, and they become the new ones here, so the tree reads one shape.
   */
  private static scriptsInto(session: SessionInfo): void {
    // An unknown setup state made an older renderer throw where it drew the badge.
    if (session.setup !== undefined && !SessionsSnapshotValidation.setupInfo(session.setup)) delete session.setup
    if (session.script !== undefined && !SessionsSnapshotValidation.scriptLink(session.script)) delete session.script
    // Also after a link of an unknown phase was dropped: every run but the resolver still carries
    // `setupFor`, so it stays nested under its parent.
    if (session.script === undefined) {
      if (typeof session.setupFor === 'string')
        session.script = { parentId: session.setupFor, phase: 'before', scriptId: 'setup' }
      else if (typeof session.resolveFor === 'string')
        session.script = { parentId: session.resolveFor, phase: 'after', scriptId: 'merge-resolve' }
    }
    if (session.scripts !== undefined) {
      const scripts = SessionsSnapshotValidation.scripts(session.scripts)
      if (scripts === null) delete session.scripts
      else session.scripts = scripts
    }
    if (session.scripts === undefined && session.setup !== undefined) session.scripts = ScriptBadges.legacyOf(session.setup)
  }

  private static setupInfo(value: unknown): boolean {
    const setup = JsonShape.record(value)
    if (setup === null) return false
    else if (setup.state === 'running' || setup.state === 'failed')
      return typeof setup.setupSessionId === 'string'
        && SessionsSnapshotValidation.every(setup.commands, (command) => typeof command === 'string')
    else if (setup.state === 'skipped') return typeof setup.reason === 'string'
    else return false
  }

  private static scriptLink(value: unknown): boolean {
    const link = JsonShape.record(value)
    return link !== null
      && typeof link.parentId === 'string'
      && SessionsSnapshotValidation.scriptPhasesConst.includes(link.phase as string)
      && SessionsSnapshotValidation.scriptIdsConst.includes(link.scriptId as string)
  }

  /** Null where it is not an object at all; otherwise what of it this build can draw. */
  private static scripts(value: unknown): SessionScriptsInfo | null {
    const scripts = JsonShape.record(value)
    if (scripts === null) return null
    const runs = Array.isArray(scripts.runs) ? scripts.runs : []
    const out: SessionScriptsInfo = {
      runs: runs.filter((run) => SessionsSnapshotValidation.scriptRun(run)) as SessionScriptRunInfo[],
    }
    if (SessionsSnapshotValidation.scriptsBadge(scripts.badge)) out.badge = scripts.badge as SessionScriptsBadge
    if (typeof scripts.waitingOn === 'string') out.waitingOn = scripts.waitingOn
    return out
  }

  private static scriptRun(value: unknown): boolean {
    const run = JsonShape.record(value)
    return run !== null
      && typeof run.runId === 'string'
      && SessionsSnapshotValidation.scriptPhasesConst.includes(run.phase as string)
      && SessionsSnapshotValidation.scriptIdsConst.includes(run.scriptId as string)
      && typeof run.name === 'string'
      && typeof run.title === 'string'
      && SessionsSnapshotValidation.runStatesConst.includes(run.state as string)
      && typeof run.summary === 'string'
      && typeof run.startedAt === 'number'
      && (run.endedAt === undefined || typeof run.endedAt === 'number')
      && (run.durationText === undefined || typeof run.durationText === 'string')
      && (run.exitCode === undefined || typeof run.exitCode === 'number')
      && SessionsSnapshotValidation.every(run.commands, (command) => typeof command === 'string')
      && typeof run.row === 'boolean'
      && (run.log === 'saved' || run.log === 'unavailable' || run.log === 'none')
      && (run.logDetail === undefined || typeof run.logDetail === 'string')
  }

  private static scriptsBadge(value: unknown): boolean {
    const badge = JsonShape.record(value)
    return badge !== null
      && (badge.phase === 'before' || badge.phase === 'after')
      && SessionsSnapshotValidation.badgeStatesConst.includes(badge.state as string)
      && typeof badge.text === 'string'
      && typeof badge.title === 'string'
      && (badge.runId === undefined || typeof badge.runId === 'string')
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
      && (session.compacting === undefined || (session.compacting === true
        && session.activity === 'working' && session.activityDetail === undefined))
      && SessionsSnapshotValidation.worktree(session.worktree)
      && SessionsSnapshotValidation.retiredWorktree(session.retiredWorktree)
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
      || (worktree.cwdSubpath !== undefined && !SessionsSnapshotValidation.filledText(worktree.cwdSubpath))
      || !SessionsSnapshotValidation.filledText(worktree.branch)
      || !SessionsSnapshotValidation.filledText(worktree.baseCommit)
      || typeof worktree.baseMoved !== 'boolean'
      || (worktree.kind !== undefined && worktree.kind !== 'svn' && worktree.kind !== 'git')
      || (worktree.choices !== undefined
        && !SessionsSnapshotValidation.every(worktree.choices, SessionsSnapshotValidation.finishChoice))
      || !SessionsSnapshotValidation.worktreeFinish(worktree.finish)
      || !SessionsSnapshotValidation.worktreeOutcome(worktree.outcome)
      || !SessionsSnapshotValidation.worktreeCleanup(worktree.cleanup))
      return false
    if (worktree.diff === null) return true
    const diff = JsonShape.record(worktree.diff)
    return diff !== null
      && SessionsSnapshotValidation.nonNegativeInteger(diff.added)
      && SessionsSnapshotValidation.nonNegativeInteger(diff.removed)
      && SessionsSnapshotValidation.nonNegativeInteger(diff.changedFiles)
      && SessionsSnapshotValidation.nonNegativeInteger(diff.capturedAt)
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
      && SessionsSnapshotValidation.finishResultsConst.includes(outcome.result as string)
      && SessionsSnapshotValidation.every(outcome.revisions, (revision) => typeof revision === 'string')
      && typeof outcome.main === 'string'
      && (outcome.worktree === 'removed' || outcome.worktree === 'kept'
        || outcome.worktree === 'in-use' || outcome.worktree === 'undeleted')
      && SessionsSnapshotValidation.every(outcome.lines, (line) => typeof line === 'string')
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
      && SessionsSnapshotValidation.filledText(retired.worktreePath)
      && SessionsSnapshotValidation.every(retired.revisions, (revision) => typeof revision === 'string')
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
