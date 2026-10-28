import { WorktreeWords } from '../worktrees/worktreeViews'
import { WorktreeStateValidation } from '../worktrees/worktreeStateValidation'
import type {
  OrphanInfo,
  SessionInfo,
  SessionParentKind,
  SessionScriptId,
  SessionScriptPhase,
  SessionScriptRunInfo,
  SessionScriptRunState,
  SessionScriptsBadge,
  SessionScriptsInfo,
  SessionsSnapshot,
  SessionSvnActionInfo,
  SvnConflictWireActor,
  SvnConflictState,
  SessionWorkflowActionId,
  SessionWorkflowInfo,
  SessionWorkflowKind,
  SessionWorkflowStepState,
  SessionWorkflowTarget,
  SvnActionNeed,
  SvnActionStage,
  SvnFinishResult,
} from './sessionManagerApi.types'
import type { SvnConflictKind, SvnConflictLoss, SvnConflictOption, SvnLocalItem } from '../svn/svn.types'
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
    ['setup', 'declared', 'merge-resolve', 'requested', 'svn', 'checks', 'svn-resolve', 'svn-merge', 'review'] satisfies readonly SessionScriptId[]
  private static readonly actionStagesConst: readonly string[] = ['main-update', 'changes', 'committing', 'stopping', 'evidence', 'checks', 'updating', 'cleaning',
    'resolving', 'merging', 'verifying', 'fixing', 'diffing', 'reviewing', 'removing', 'recording'] satisfies readonly SvnActionStage[]
  private static readonly actionNeedsConst: readonly string[] = ['check-failed', 'conflict', 'resolver-failed', 'incoming',
    'out-of-date', 'review-cancelled', 'review-interrupted', 'partial', 'pinned-external', 'locked', 'svn-failed',
    'removal-blocked', 'not-stopped', 'worker-busy'] satisfies readonly SvnActionNeed[]
  private static readonly runStatesConst: readonly string[] =
    ['running', 'succeeded', 'failed', 'stopped', 'lost'] satisfies readonly SessionScriptRunState[]
  private static readonly badgeStatesConst: readonly string[] =
    ['running', 'failed', 'skipped', 'succeeded'] satisfies readonly SessionScriptsBadge['state'][]
  private static readonly parentKindsConst: readonly string[] = ['worktree', 'ticket', 'worker'] satisfies readonly SessionParentKind[]
  private static readonly localItemsConst: readonly string[] = ['added', 'conflicted', 'deleted', 'external', 'ignored', 'merged', 'obstructed',
    'replaced', 'unversioned'] satisfies readonly SvnLocalItem[]
  private static readonly workflowKindsConst: readonly string[] =
    ['before', 'finish', 'discard', 'update-main', 'git-finish', 'script'] satisfies readonly SessionWorkflowKind[]
  private static readonly workflowStatesConst: readonly string[] =
    ['pending', 'running', 'done', 'failed', 'waits', 'skipped'] satisfies readonly SessionWorkflowStepState[]
  private static readonly workflowTargetsConst: readonly string[] =
    ['run', 'agent', 'commit', 'conflicts', 'none'] satisfies readonly SessionWorkflowTarget['kind'][]
  private static readonly conflictKindsConst: readonly string[] =
    ['text', 'property', 'tree', 'diverged'] satisfies readonly SvnConflictKind[]
  private static readonly conflictStatesConst: readonly string[] =
    ['rule', 'agent', 'person', 'settled'] satisfies readonly SvnConflictState[]
  private static readonly conflictActorsConst: readonly string[] =
    ['jamat', 'agent', 'person'] satisfies readonly SvnConflictWireActor[]
  private static readonly conflictOptionsConst: readonly string[] =
    ['merged', 'take-incoming', 'keep-mine', 'keep-both', 'union'] satisfies readonly SvnConflictOption[]
  private static readonly conflictLossesConst: readonly string[] =
    ['nothing', 'mine', 'incoming'] satisfies readonly SvnConflictLoss[]
  private static readonly workflowActionsConst: readonly string[] =
    ['refresh-preparation', 'prepare-worktree', 'confirm-environment', 'override-checks', 'review-correction', 'finish-again', 'keep', 'discard', 'retry-setup', 'stop-agent', 'open-in-vscode', 'resolve-with-agent', 'open-merger', 'solve-with-agent', 'agree-setup', 'cancel-setup', 'update-main', 'later', 'back-to-work', 'confirm-stopped', 'stop-run', 'remove-run', 'confirm-busy', 'resume-worker'] satisfies readonly SessionWorkflowActionId[]

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
    // Optional and newer than many peers: a reading this build cannot draw costs the field, never the snapshot.
    if (parsed.host.memory !== undefined && parsed.host.memory !== null
      && !SessionsSnapshotValidation.hostMemory(parsed.host.memory)) delete parsed.host.memory
    if (parsed.host.workingAgents !== undefined
      && (!Array.isArray(parsed.host.workingAgents) || parsed.host.workingAgents.length > 1024
        || !parsed.host.workingAgents.every((name) => typeof name === 'string' && name.length <= 1024))) delete parsed.host.workingAgents
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
      if (session.worktreeView !== undefined && WorktreeStateValidation.view(session.worktreeView) === undefined)
        delete session.worktreeView
      // Optional and newer than many peers: a value this build cannot draw costs the field, never the session.
      if (session.svnAction !== undefined && !SessionsSnapshotValidation.svnAction(session.svnAction)) delete session.svnAction
      if (session.svnAction !== undefined) SessionsSnapshotValidation.conflictsInto(session.svnAction)
      if (session.worktree?.liveFinish !== undefined && session.worktree.liveFinish !== true) delete session.worktree.liveFinish
      if (session.retiredWorktree?.landing !== undefined && !SessionsSnapshotValidation.landing(session.retiredWorktree.landing))
        delete session.retiredWorktree.landing
      // A list this build cannot read costs where the main copy is behind, never the landed row.
      if (session.retiredWorktree?.landing?.behindRoots !== undefined
        && !SessionsSnapshotValidation.every(session.retiredWorktree.landing.behindRoots, SessionsSnapshotValidation.behindRoot))
        delete session.retiredWorktree.landing.behindRoots
      if (session.retiredWorktree?.landing !== undefined && 'local' in session.retiredWorktree.landing
        && !SessionsSnapshotValidation.landingLocal(session.retiredWorktree.landing.local))
        delete session.retiredWorktree.landing.local
      // A newer peer's kind costs the link, so the child is drawn as a root.
      if (session.parent !== undefined && !SessionsSnapshotValidation.parent(session.parent)) delete session.parent
      if (session.step !== undefined && !SessionsSnapshotValidation.step(session.step)) delete session.step
      if (session.workflow !== undefined) {
        const workflow = SessionsSnapshotValidation.workflow(session.workflow)
        if (workflow === null) delete session.workflow
        else session.workflow = workflow
      }
      if (session.actions !== undefined) {
        const actions = JsonShape.record(session.actions)
        if (actions === null || !Array.isArray(actions.sections)) delete session.actions
        else session.actions = { sections: actions.sections.flatMap((section) => {
          const workflow = SessionsSnapshotValidation.workflow(section)
          return workflow === null ? [] : [workflow]
        }) }
      }
    }
    for (const session of parsed.sessions) WorktreeWords.decorate(session)
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

  /** A summary or a conflict list this build cannot draw costs that part, never the action. */
  private static conflictsInto(action: SessionSvnActionInfo): void {
    if (action.summary !== undefined && action.summary !== null && typeof action.summary !== 'string') delete action.summary
    if (action.mergeBrief !== undefined && action.mergeBrief !== null && typeof action.mergeBrief !== 'string') delete action.mergeBrief
    if (action.mergerRunId !== undefined && action.mergerRunId !== null && typeof action.mergerRunId !== 'string') delete action.mergerRunId
    if (action.conflicts === undefined || action.conflicts === null) return
    const conflicts = JsonShape.record(action.conflicts)
    if (conflicts === null || !SessionsSnapshotValidation.nonNegativeInteger(conflicts.more)
      || !SessionsSnapshotValidation.every(conflicts.entries, SessionsSnapshotValidation.conflict)) delete action.conflicts
  }

  private static conflict(value: unknown): boolean {
    const entry = JsonShape.record(value)
    return entry !== null && SessionsSnapshotValidation.filledText(entry.path) && typeof entry.description === 'string'
      && SessionsSnapshotValidation.conflictKindsConst.includes(entry.kind as string)
      && SessionsSnapshotValidation.conflictStatesConst.includes(entry.state as string)
      && (entry.by === null || SessionsSnapshotValidation.conflictActorsConst.includes(entry.by as string))
      && (entry.settled === undefined || typeof entry.settled === 'string')
      && (entry.saved === null || typeof entry.saved === 'string')
      && SessionsSnapshotValidation.every(entry.options, (item) => {
        const option = JsonShape.record(item)
        return option !== null && SessionsSnapshotValidation.conflictOptionsConst.includes(option.id as string)
          && typeof option.label === 'string' && typeof option.note === 'string'
          && SessionsSnapshotValidation.conflictLossesConst.includes(option.loses as string)
      })
  }

  /**
   * A step state or a target this build cannot draw costs the workflow; an action it cannot press
   * costs that action only.
   */
  private static workflow(value: unknown): SessionWorkflowInfo | null {
    const workflow = JsonShape.record(value)
    if (workflow === null || !SessionsSnapshotValidation.workflowKindsConst.includes(workflow.kind as string)
      || ![workflow.workflowId, workflow.title, workflow.badge, workflow.summary].every((text) => typeof text === 'string')
      || typeof workflow.open !== 'boolean'
      || !SessionsSnapshotValidation.every(workflow.rounds, SessionsSnapshotValidation.workflowRound)
      || !Array.isArray(workflow.actions))
      return null
    const actions = workflow.actions.filter(SessionsSnapshotValidation.workflowAction)
    const parsed = value as SessionWorkflowInfo
    const rounds = parsed.rounds.map((round) => ({ ...round, steps: round.steps.map((step) => {
      const { body, ...rest } = step
      return SessionsSnapshotValidation.workflowBody(body) ? step : rest
    }) }))
    const timestamps = { startedAt: parsed.startedAt, endedAt: parsed.endedAt }
    for (const key of ['startedAt', 'endedAt'] as const)
      if (typeof timestamps[key] !== 'number' || !Number.isFinite(timestamps[key])) timestamps[key] = undefined
    const validation = JsonShape.record(parsed.validation)
    const validValidation = validation !== null && typeof validation.cwd === 'string' && typeof validation.canRun === 'boolean'
      && ['pending', 'passed', 'none', 'overridden'].includes(validation.checks as string)
      && (validation.checkedAt === undefined || typeof validation.checkedAt === 'number' && Number.isFinite(validation.checkedAt))
      && (validation.environmentInputs === undefined || SessionsSnapshotValidation.every(validation.environmentInputs, (path) => typeof path === 'string'))
      && (validation.requiredSelection === undefined || SessionsSnapshotValidation.every(validation.requiredSelection, (path) => typeof path === 'string'))
    // A run list this build cannot press costs the list, never the validation it belongs to.
    const runsValid = validation?.runs === undefined || SessionsSnapshotValidation.every(validation.runs, SessionsSnapshotValidation.validationRun)
    const validated = !validValidation ? undefined : runsValid ? parsed.validation : { ...parsed.validation!, runs: undefined }
    return { ...parsed, ...timestamps, validation: validated, rounds, actions: actions as SessionWorkflowInfo['actions'] }
  }

  private static workflowAction(item: unknown): boolean {
    const action = JsonShape.record(item)
    return action !== null && SessionsSnapshotValidation.workflowActionsConst.includes(action.id as string)
      && typeof action.label === 'string' && typeof action.primary === 'boolean'
      && ((action.id !== 'stop-agent' && action.id !== 'stop-run' && action.id !== 'remove-run' && action.id !== 'confirm-stopped' && action.id !== 'open-merger') || typeof action.runId === 'string')
      && (action.id !== 'agree-setup' || SessionsSnapshotValidation.filledText(action.acknowledgeSetup))
      && (action.id !== 'update-main' || SessionsSnapshotValidation.every(action.confirmLive, SessionsSnapshotValidation.filledText))
      && (action.requiresCommit === undefined || action.requiresCommit === true)
      && (action.confirm === undefined || typeof action.confirm === 'string')
      && (action.place === undefined || action.place === 'step')
      && (action.deferred === undefined || typeof action.deferred === 'string')
      && (action.note === undefined || typeof action.note === 'string')
  }

  private static validationRun(value: unknown): boolean {
    const run = JsonShape.record(value)
    const stop = JsonShape.record(run?.stop)
    return run !== null && typeof run.runId === 'string' && typeof run.title === 'string'
      && typeof run.startedAt === 'number' && Number.isFinite(run.startedAt)
      && stop !== null && stop.id === 'stop-run' && stop.runId === run.runId && SessionsSnapshotValidation.workflowAction(stop)
  }

  private static workflowBody(value: unknown): boolean {
    const body = JsonShape.record(value)
    if (body === null) return false
    switch (body.kind) {
      case 'sessions': return (body.liveUnknown === undefined || body.liveUnknown === true) && SessionsSnapshotValidation.every(body.sessions, (value) => {
        const session = JsonShape.record(value)
        return session !== null && SessionsSnapshotValidation.filledText(session.sessionId) && typeof session.title === 'string'
          && (session.number === null || typeof session.number === 'string')
      })
      case 'commit': return (body.vcs === 'svn' || body.vcs === 'git') && SessionsSnapshotValidation.filledText(body.scopeRoot)
        && (body.marked === undefined || Array.isArray(body.marked) && body.marked.every((path) => typeof path === 'string'))
      case 'commands': return Array.isArray(body.commands) && body.commands.every((command) => typeof command === 'string')
      case 'log': return SessionsSnapshotValidation.filledText(body.runId)
      case 'conflicts': {
        const conflicts = body.conflicts === undefined ? undefined : JsonShape.record(body.conflicts)
        return (body.summary === undefined || typeof body.summary === 'string')
          && (body.mergeBrief === undefined || body.mergeBrief === null || typeof body.mergeBrief === 'string')
          && (conflicts === undefined || conflicts !== null && SessionsSnapshotValidation.nonNegativeInteger(conflicts.more)
            && SessionsSnapshotValidation.every(conflicts.entries, SessionsSnapshotValidation.conflict))
      }
      default: return false
    }
  }

  private static workflowRound(value: unknown): boolean {
    const round = JsonShape.record(value)
    return round !== null && typeof round.title === 'string' && SessionsSnapshotValidation.every(round.steps, (item) => {
      const step = JsonShape.record(item)
      const target = JsonShape.record(step?.target)
      return step !== null && target !== null
        && [step.key, step.title, step.detail].every((text) => typeof text === 'string')
        && SessionsSnapshotValidation.workflowStatesConst.includes(step.state as string)
        && (step.startedAt === null || Number.isSafeInteger(step.startedAt))
        && (step.endedAt === null || Number.isSafeInteger(step.endedAt))
        && SessionsSnapshotValidation.workflowTargetsConst.includes(target.kind as string)
        && (target.kind === 'none' || target.kind === 'conflicts' || SessionsSnapshotValidation.filledText(target.runId))
    })
  }

  private static step(value: unknown): boolean {
    const step = JsonShape.record(value)
    if (step === null || typeof step.text !== 'string' || (step.detail !== null && typeof step.detail !== 'string')) return false
    if (step.startedAt !== null && !Number.isSafeInteger(step.startedAt)) return false
    if (step.progress === null) return true
    const progress = JsonShape.record(step.progress)
    return progress !== null && SessionsSnapshotValidation.nonNegativeInteger(progress.done)
      && (progress.total === null || SessionsSnapshotValidation.nonNegativeInteger(progress.total))
  }

  private static parent(value: unknown): boolean {
    const parent = JsonShape.record(value)
    return parent !== null && SessionsSnapshotValidation.filledText(parent.sessionId)
      && SessionsSnapshotValidation.parentKindsConst.includes(parent.kind as string)
      && typeof parent.sameProject === 'boolean'
  }

  private static landing(value: unknown): boolean {
    const landing = JsonShape.record(value)
    return landing !== null && SessionsSnapshotValidation.filledText(landing.mainCopy)
      && (landing.behind === null || SessionsSnapshotValidation.nonNegativeInteger(landing.behind))
      && SessionsSnapshotValidation.every(landing.newest, (revision) => typeof revision === 'string')
  }

  private static landingLocal(value: unknown): boolean {
    const local = JsonShape.record(value)
    return local !== null && SessionsSnapshotValidation.filledText(local.path) && SessionsSnapshotValidation.localItemsConst.includes(local.item as string)
      && SessionsSnapshotValidation.filledText(local.summary)
  }

  private static behindRoot(value: unknown): boolean {
    const root = JsonShape.record(value)
    return root !== null && SessionsSnapshotValidation.filledText(root.root) && SessionsSnapshotValidation.nonNegativeInteger(root.behind)
      && (root.behind as number) > 0
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

  private static hostMemory(value: unknown): boolean {
    const memory = JsonShape.record(value)
    return memory !== null
      && SessionsSnapshotValidation.every(memory.lines, (line) => typeof line === 'string')
      && SessionsSnapshotValidation.optionalText(memory.warning)
      && SessionsSnapshotValidation.optionalText(memory.suffix)
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
      && (session.runtime === undefined || typeof session.runtime === 'string')
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
