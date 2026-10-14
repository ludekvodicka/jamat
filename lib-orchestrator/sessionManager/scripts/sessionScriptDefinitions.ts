import { SvnActionStages } from '../lifecycle/svnActionStages'
import type { SessionRecord, SessionRecordScriptLink } from '../records/sessionRecord.types'
import type { SessionScriptId, SessionScriptPhase } from '../sessionManagerApi.types'

/** The parent field that waits for a run's verdict, which also names the flow that acts on it. */
export type SessionScriptGate = 'before' | 'finish' | 'merge' | 'action'

/** What becomes of a tab on the run once it collapses: the parent's terminal takes its place, or it closes. */
export type SessionScriptHandoff = 'parent-tab' | 'close'

/**
 * The ladder's nouns. They are what a person reads, so each script names them rather than having
 * them derived: "its <session> session record is gone", "the <actor> exited with 1".
 */
export interface SessionScriptWords {
  session: string
  actor: string
}

/** One gate of a parent: the run it names now, that run's kind and the words its ladder speaks. */
export interface SessionScriptGateEntry {
  gate: SessionScriptGate
  runId: string
  definition: SessionScriptDefinition
  words: SessionScriptWords
}

export interface SessionScriptDefinition {
  phase: SessionScriptPhase
  scriptId: SessionScriptId
  /** Which parent gate waits for the run; null: nothing waits for it. */
  gate: SessionScriptGate | null
  /** The run the parent names now through its own gate field, or null. */
  pointerOf(parent: SessionRecord): string | null
  words: SessionScriptWords
  /**
   * False: a run found starting without a runtime is lost rather than launched again. Its caller asked
   * once and moved on, so a replay minutes later would run it for nobody.
   */
  replayable: boolean
  /** True: the run is stopped once its parent no longer runs. */
  stopsWithParent: boolean
  handoff: SessionScriptHandoff
  /**
   * True: while the run runs, its last output line is drawn under its row (`RunOutputLines`). False for
   * the resolvers and the review, whose screen is an agent's conversation rather than progress.
   */
  liveLine: boolean
}

/**
 * Every kind of script run as a row of data, so the code that judges, replays and dispatches runs
 * names no script. A new kind is a new row here and a handler for its gate.
 */
export class SessionScriptDefinitions {
  private static readonly beforeSetupConst: SessionScriptDefinition = {
    phase: 'before',
    scriptId: 'setup',
    gate: 'before',
    pointerOf: (parent) => parent.pendingSetup?.setupSessionId ?? null,
    words: { session: 'setup', actor: 'setup' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'parent-tab',
    liveLine: true,
  }

  /**
   * A step of the before chain the project named in `scripts.before`. It shares the setup's gate and
   * pointer: the chain is one wait, and its cursor says which step the pointer names.
   */
  private static readonly beforeDeclaredConst: SessionScriptDefinition = {
    phase: 'before',
    scriptId: 'declared',
    gate: 'before',
    pointerOf: (parent) => parent.pendingSetup?.setupSessionId ?? null,
    words: { session: 'script', actor: 'script' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'parent-tab',
    liveLine: true,
  }

  /**
   * The `svn checkout` that leads the before chain of an SVN worktree, spawned directly in the folder
   * the create reserved. It shares the setup's gate and pointer like a declared step.
   */
  private static readonly beforeSvnConst: SessionScriptDefinition = {
    phase: 'before',
    scriptId: 'svn',
    gate: 'before',
    pointerOf: (parent) => parent.pendingSetup?.setupSessionId ?? null,
    words: { session: 'checkout', actor: 'checkout' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'parent-tab',
    liveLine: true,
  }

  /** A step of the after chain a Finish press runs: the project's `scripts.after`, before the finisher. */
  private static readonly afterDeclaredConst: SessionScriptDefinition = {
    phase: 'after',
    scriptId: 'declared',
    gate: 'finish',
    pointerOf: (parent) => parent.finishChecks?.runId ?? null,
    words: { session: 'check', actor: 'check' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'close',
    liveLine: true,
  }

  private static readonly resolverConst: SessionScriptDefinition = {
    phase: 'after',
    scriptId: 'merge-resolve',
    gate: 'merge',
    // Kept after a failed resolver on purpose (`worktreeMergeFlow`), so it is read as it stands.
    pointerOf: (parent) => parent.worktreeMerge?.resolveSessionId ?? null,
    words: { session: 'resolve', actor: 'resolver' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'close',
    liveLine: false,
  }

  /** An `svn update` or `svn cleanup` of an SVN action, spawned directly; the step names which. */
  private static readonly afterSvnConst: SessionScriptDefinition = {
    phase: 'after',
    scriptId: 'svn',
    gate: 'action',
    pointerOf: (parent) => SessionScriptDefinitions.actionPointerOf(parent),
    words: { session: 'svn', actor: 'svn' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'close',
    liveLine: true,
  }

  /** A `scripts.after` entry an SVN action froze at its press. */
  private static readonly afterChecksConst: SessionScriptDefinition = {
    phase: 'after',
    scriptId: 'checks',
    gate: 'action',
    pointerOf: (parent) => SessionScriptDefinitions.actionPointerOf(parent),
    words: { session: 'check', actor: 'check' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'close',
    liveLine: true,
  }

  /** The Claude one-shot that resolves the text conflicts an SVN action's update left; the action verifies its work. */
  private static readonly svnResolverConst: SessionScriptDefinition = {
    phase: 'after',
    scriptId: 'svn-resolve',
    gate: 'action',
    pointerOf: (parent) => SessionScriptDefinitions.actionPointerOf(parent),
    words: { session: 'resolve', actor: 'resolver' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'close',
    liveLine: false,
  }

  /**
   * The interactive Claude merger of an SVN Finish: it settles the conflicts the rules left through
   * `jamat-v3 sessions resolve-conflict`. Jamat stops it after the last settlement, or judges it when
   * it ends, whatever its exit code.
   */
  private static readonly svnMergerConst: SessionScriptDefinition = {
    phase: 'after',
    scriptId: 'svn-merge',
    gate: 'action',
    pointerOf: (parent) => SessionScriptDefinitions.actionPointerOf(parent),
    words: { session: 'merge', actor: 'merger' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'close',
    liveLine: false,
  }

  /** The commit review of one root of an SVN action, hosted by `jamat-v3 sessions worktree-review`. */
  private static readonly reviewConst: SessionScriptDefinition = {
    phase: 'after',
    scriptId: 'review',
    gate: 'action',
    pointerOf: (parent) => SessionScriptDefinitions.actionPointerOf(parent),
    words: { session: 'review', actor: 'review' },
    replayable: true,
    stopsWithParent: false,
    handoff: 'close',
    liveLine: false,
  }

  /** A shell run a live session asked for through the control API; nothing waits for its verdict. */
  private static readonly requestedConst: SessionScriptDefinition = {
    phase: 'inner',
    scriptId: 'requested',
    gate: null,
    pointerOf: () => null,
    words: { session: 'run', actor: 'run' },
    replayable: false,
    stopsWithParent: true,
    handoff: 'close',
    liveLine: true,
  }

  private static readonly allConst: readonly SessionScriptDefinition[] = [
    SessionScriptDefinitions.beforeSetupConst,
    SessionScriptDefinitions.beforeDeclaredConst,
    SessionScriptDefinitions.beforeSvnConst,
    SessionScriptDefinitions.afterDeclaredConst,
    SessionScriptDefinitions.resolverConst,
    SessionScriptDefinitions.afterSvnConst,
    SessionScriptDefinitions.afterChecksConst,
    SessionScriptDefinitions.svnResolverConst,
    SessionScriptDefinitions.svnMergerConst,
    SessionScriptDefinitions.reviewConst,
    SessionScriptDefinitions.requestedConst,
  ]

  /**
   * The run an SVN action names while a run stage waits on it. A client stage names none, so the run
   * it moved past collapses into the history.
   */
  private static actionPointerOf(parent: SessionRecord): string | null {
    const action = parent.svnAction
    return action !== undefined && SvnActionStages.isRun(action.stage) ? action.runId ?? null : null
  }

  static of(link: Pick<SessionRecordScriptLink, 'phase' | 'scriptId'>): SessionScriptDefinition {
    const found = SessionScriptDefinitions.find(link)
    if (found === undefined) throw new Error(`Unknown script: ${JSON.stringify(`${link.phase}/${link.scriptId}`)}`)
    return found
  }

  /** The link a flow writes on the run it launches; a pair with no definition throws rather than being written. */
  static linkOf(
    parentId: string,
    phase: SessionScriptPhase,
    scriptId: SessionScriptId,
    name: string,
    stepKey?: string,
  ): SessionRecordScriptLink {
    SessionScriptDefinitions.of({ phase, scriptId })
    const link: SessionRecordScriptLink = { sessionId: parentId, phase, scriptId, name }
    if (stepKey !== undefined) link.stepKey = stepKey
    return link
  }

  /**
   * The ladder's nouns for one run. A step is named by its entry, so a person reads which of the
   * project's scripts failed: "the codegen script exited with 2", "the tests check", "the svn update".
   * The checkout before a session is one step only: "the checkout exited with 1".
   */
  static wordsOf(link: Pick<SessionRecordScriptLink, 'phase' | 'scriptId' | 'name'>): SessionScriptWords {
    const definition = SessionScriptDefinitions.of(link)
    let noun: string
    if (link.scriptId === 'declared' || link.scriptId === 'checks') noun = `${link.name} ${definition.words.actor}`
    else if (link.scriptId === 'svn' && link.phase === 'before') return definition.words
    else if (link.scriptId === 'svn') noun = `${definition.words.actor} ${link.name}`
    else if (link.scriptId === 'setup' || link.scriptId === 'merge-resolve' || link.scriptId === 'requested'
      || link.scriptId === 'svn-resolve' || link.scriptId === 'svn-merge' || link.scriptId === 'review') return definition.words
    else throw new Error(`Unknown script: ${JSON.stringify(link.scriptId satisfies never)}`)
    return { session: noun, actor: noun }
  }

  /** Whether `of` answers for this pair; the records store refuses a link it would throw on. */
  static known(link: Pick<SessionRecordScriptLink, 'phase' | 'scriptId'>): boolean {
    return SessionScriptDefinitions.find(link) !== undefined
  }

  private static find(link: Pick<SessionRecordScriptLink, 'phase' | 'scriptId'>): SessionScriptDefinition | undefined {
    return SessionScriptDefinitions.allConst
      .find((definition) => definition.phase === link.phase && definition.scriptId === link.scriptId)
  }

  /**
   * Every gate a parent holds, once each, with the run it names and that run's definition and words.
   * Two definitions share the before gate, so the step its cursor names decides which one speaks.
   */
  static gatesOf(parent: SessionRecord): readonly SessionScriptGateEntry[] {
    const gates: SessionScriptGateEntry[] = []
    for (const candidate of SessionScriptDefinitions.allConst) {
      const gate = candidate.gate
      if (gate === null || gates.some((entry) => entry.gate === gate)) continue
      const runId = candidate.pointerOf(parent)
      if (runId === null) continue
      const link = SessionScriptDefinitions.namedLinkOf(candidate, gate, parent)
      gates.push({
        gate,
        runId,
        definition: SessionScriptDefinitions.of(link),
        words: SessionScriptDefinitions.wordsOf(link),
      })
    }
    return gates
  }

  /** What the gate's pointer names, read off the parent: the before chain's step at its cursor. */
  private static namedLinkOf(
    candidate: SessionScriptDefinition,
    gate: SessionScriptGate,
    parent: SessionRecord,
  ): Pick<SessionRecordScriptLink, 'phase' | 'scriptId' | 'name'> {
    if (gate === 'before') {
      const step = parent.pendingSetup?.steps?.[parent.pendingSetup.cursor ?? 0]
      return step === undefined
        ? { phase: 'before', scriptId: 'setup', name: 'setup' }
        : { phase: 'before', scriptId: step.scriptId, name: step.name }
    }
    else if (gate === 'finish') {
      const checks = parent.finishChecks
      const step = checks?.steps[checks.cursor]
      if (step === undefined) throw new Error(`Session ${parent.sessionId} names a Finish check its steps do not hold`)
      return { phase: 'after', scriptId: step.scriptId, name: step.name }
    }
    else if (gate === 'merge') return { phase: candidate.phase, scriptId: candidate.scriptId, name: 'resolver' }
    else if (gate === 'action') {
      const action = parent.svnAction
      if (action === undefined) throw new Error(`Session ${parent.sessionId} names an SVN action it does not hold`)
      return SvnActionStages.linkOf(action)
    }
    else throw new Error(`Unknown script gate: ${JSON.stringify(gate satisfies never)}`)
  }

  /**
   * Whether the gate still waits for a verdict, read off the parent alone; the Reconciler adds the
   * Host's side.
   *
   * `before` wants the pending pair: without it no verdict can start anything, and judging for ever
   * a record nothing can move is a session frozen in silence. Such a record falls through to the
   * general rule, which reads it as lost.
   *
   * `finish` wants no result: a chain that passed or failed has been judged, and only the next Finish
   * press starts another.
   *
   * `merge` wants no failure beside the phase: a failure already written is a judgement already
   * made, and judging again every pass would rewrite the same record for ever.
   *
   * `action` wants a run stage with no verdict yet, no wait for the person and no relaunch pending:
   * each of those is a judgement already written or a run that is not the one to judge.
   */
  static judging(gate: SessionScriptGate, parent: SessionRecord): boolean {
    if (gate === 'before')
      return parent.life === 'starting'
        && Boolean(parent.pendingSetup && parent.pendingOperationId && parent.pendingOperationKind)
    else if (gate === 'finish')
      return parent.finishChecks !== undefined && parent.finishChecks.result === undefined
    else if (gate === 'merge')
      return parent.worktreeMerge?.phase === 'resolving'
        && parent.worktreeMerge.resolveSessionId !== undefined
        && parent.worktreeMerge.failure === undefined
    else if (gate === 'action') {
      const action = parent.svnAction
      return action?.runId !== undefined && action.needs === undefined && action.verdict === undefined
        && action.retryAt === undefined && SvnActionStages.isRun(action.stage)
    }
    else
      throw new Error(`Unknown script gate: ${JSON.stringify(gate satisfies never)}`)
  }

  /**
   * Whether the run's gate on this parent still waits for this run's verdict. Removing the run then
   * would make the gate read the gone record as a failure, so Remove is neither offered nor taken.
   */
  static awaitsVerdictOf(runId: string, link: SessionRecordScriptLink, parent: SessionRecord): boolean {
    const definition = SessionScriptDefinitions.of(link)
    return definition.gate !== null && definition.pointerOf(parent) === runId
      && SessionScriptDefinitions.judging(definition.gate, parent)
  }
}
