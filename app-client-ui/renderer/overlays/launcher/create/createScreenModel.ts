import { WorktreeNaming } from '../../../../../lib-orchestrator/git/worktreeNaming'
import { SessionTitle } from '../../../../../lib-orchestrator/sessionManager/records/sessionTitle'
import type { ProviderSessionSummary } from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  RemoteControlAgentDto,
} from '../../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  SessionAgentId,
  SessionCreateSpec,
  SessionHistoryOpenSpec,
  SessionSetupAgreement,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { FlowCatalog } from '../flows/flowCatalog'
import type { LauncherBinding } from '../launcherBinding'
import type { LauncherSessionPrefill } from '../launcherIntentStore'
import { LauncherLabels } from '../launcherLabels'
import type { LauncherTarget } from '../launcherTarget'

export type CreateType =
  | { kind: 'raw' }
  | { kind: 'flow'; flowId: string }
  | { kind: 'existing' }
  | { kind: 'shell' }

/**
 * The session the card was opened ON, drawn as the first ROW of Continue/Fork and chosen there.
 *
 * It was a type of its own until 2026-09-10 - one card called Fork, one called Resume - standing
 * beside a Continue/Fork whose own words are "resume ended sessions, fork running ones". That is
 * one operation drawn twice, and the card opened from a session's menu answers the question the
 * list asks rather than replacing it: which conversation, and this one.
 *
 * A row rather than an index into the loaded list, because that list is the PROJECT's transcripts:
 * a session in a worktree writes its own somewhere else, an ad-hoc directory has no project list at
 * all, and a codex session names its conversation late. The row stands for the session in every one
 * of those cases, and what it submits is composed by the library out of that session's record.
 */
export type CreateSessionTarget = LauncherSessionPrefill

/** Which row the cursor stands on. `↑↓` moves between them and `←→` chooses inside one. */
export type CreateField = 'name' | 'type' | 'isolation' | 'agent' | 'model' | 'existingSessions'
export type ExistingAgentFilter = SessionAgentId | 'all'

export interface ExistingSessionSummary extends ProviderSessionSummary {
  /** Exact V3 tree title when this provider conversation already has a local record. */
  localTitle: string | null
}

/**
 * One session of the computer this card is aimed at, as that computer's own snapshot describes it.
 *
 * Not a `ProviderSessionSummary`: reading another machine's transcripts is not something this one
 * can do, so Continue on a remote card offers the sessions that computer keeps rather than the
 * conversations its agents left behind.
 */
export interface RemoteExistingSession {
  sessionId: string
  /** What a tab holding it is called. The target composed it, so nothing here rebuilds it. */
  tabTitle: string
  title: string
  agentId: SessionAgentId | null
  /** Running now, which is the difference between opening a tab and asking for a reopen first. */
  running: boolean
}

/**
 * A row of the Continue list, whichever of the two lists the target names. One shape because the
 * list itself is one thing - a cursor, a scroll, an empty state - and only what fills it differs.
 */
export interface ExistingRow {
  key: string
  label: string
  /** Nothing ever named it: drawn as a placeholder rather than as a title somebody chose. */
  untitled: boolean
  agentId: SessionAgentId | null
  active: boolean
  /** The provider's timestamps. A target session carries none and leaves the column empty. */
  times: { lastActivity: number; createdAt: number } | null
  /**
   * Present only on the row the card was opened on, which is why that row leads the list. Without
   * it the row is one conversation among the project's, drawn where nothing put it.
   */
  mark: string | null
}

/**
 * What Enter acts on, from the row the cursor stands on. Three kinds because there are three: the
 * session the card was opened on, a conversation this machine's agents left behind, and a session
 * the target computer keeps. Each is opened by its own call, and none of them is the other two with
 * a field missing.
 */
export type ExistingSelection =
  | { kind: 'source'; source: CreateSessionTarget }
  | { kind: 'summary'; summary: ExistingSessionSummary }
  | { kind: 'remote'; session: RemoteExistingSession }

/**
 * What the TARGET said it can start an agent on, and the four ways that question can stand.
 *
 * `refused` is the whole model feature's version marker rather than an error: a target that
 * predates `agents.describe` never negotiated the capability, so the ask is refused locally without
 * a round trip - and a `model` sent to that target would be refused as an invalid request in full,
 * because its create validator reads exact keys. So `ready` is the ONE state a model travels from.
 */
export type CreateModelsState =
  /** A local card: the model of a session started here is this computer's own setting. */
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; agents: readonly RemoteControlAgentDto[] }
  | { status: 'refused' }
  | { status: 'unreachable'; detail: string }

/** One line of the model picker, as the TARGET's own catalog names it. */
export interface CreateModelOption {
  /** Null leaves the choice to the target: nothing travels and it reads its own settings. */
  id: string | null
  label: string
  /** The catalog's own remark, absent for a bare id the target no longer lists. */
  note: string | null
}

export interface CreateScreenState {
  binding: LauncherBinding
  /**
   * Which computer this card starts on. A closed discriminant: the fields it hides, the list it
   * fills Continue from, the channel the submit goes down and the refusals it says are all decided
   * by it, and every branch over it throws on a kind nobody has decided about.
   */
  target: LauncherTarget
  /**
   * The same screen asking a shorter question: a short type list and no isolation. It names the FORM
   * and not the result, which is why it is not called `plainTab` any more - `New` and `Shell` from
   * this profile are plain tabs, while `Continue/Fork` is a session of the tree like any other.
   */
  tabProfile: boolean
  field: CreateField
  /** Into `CreateScreenModel.typesOf`, which grows with the flow catalog and not with this file. */
  typeIndex: number
  agentId: SessionAgentId
  /** What the target offers, asked once when a remote card opens and again only on request. */
  models: CreateModelsState
  /**
   * The model explicitly chosen for this session, null being "leave it to the target". Only a
   * chosen one reaches the spec: the absence of the field is what makes a remote create behave
   * exactly as it did before this row existed.
   */
  modelId: string | null
  /**
   * The session this card was opened ON, or null. It leads the Continue/Fork list as a row of its
   * own, that type opens chosen with the cursor on it, and `mode` says which of the list's two
   * words applies to it. Its submit sends the session's id and nothing else: what a fork or a
   * resume IS gets composed by the library out of that record.
   */
  source: CreateSessionTarget | null
  existingAgentFilter: ExistingAgentFilter
  existingSessions: readonly ExistingSessionSummary[] | null
  /** The target's own sessions in this project, for a remote card. Null while none has been read. */
  remoteSessions: readonly RemoteExistingSession[] | null
  existingSessionsError: string | null
  existingCursor: number
  /** What was typed, without the number. The title is the two of them joined at submit. */
  name: string
  /**
   * This session's number in its project, peeked when the card opened. Null for an ad-hoc or default
   * binding, and null when the numbers could not be read - neither ever blocks a create.
   */
  token: string | null
  worktree: boolean
  /**
   * `setup` is present only on `setup-not-acknowledged`, which is the one refusal a person can answer
   * from here: the library hands back the commands to show and the hash to answer with.
   */
  submitError: {
    code: string
    detail: string
    setup?: SessionSetupAgreement
  } | null
  /** The hash agreed to, travelling with the next submit and no further: it answers ONE question. */
  acknowledgeSetup: string | null
  /**
   * The remote create whose answer never arrived, held WHOLE so that Retry repeats it rather than
   * sending a second one. The far side keys its replay store by the operation id and refuses the
   * same id with a different body as a conflict, so the spec travels with the id: a letter typed
   * into the name between the two attempts would otherwise turn a replay into a conflict.
   *
   * Null after every definitive answer, `setup-not-acknowledged` included - that one IS an answer,
   * and the confirmed second attempt carries a different body on purpose.
   */
  pendingCreate: { operationId: string; spec: SessionCreateSpec } | null
  /**
   * The chosen computer is no longer connected. A normal state rather than an error that takes the
   * card away: what was typed is still here, and the card says why nothing can start from it.
   */
  targetLost: boolean
  /** A create takes seconds, and a second Enter in that time is a second session nobody wanted. */
  submitting: boolean
}

export type CreateScreenInput =
  /**
   * `projectPath` says which project the number was read for. A peek is one round trip, and a
   * card left and reopened elsewhere has two in flight: the older answer used to be drawn beside
   * the new project's name and to feed the branch preview, so the slug named another project's
   * number.
   */
  | { input: 'numberLoaded'; projectPath: string; token: string | null }
  | { input: 'moveField'; delta: number }
  | { input: 'setField'; field: CreateField }
  | { input: 'chooseType'; index: number }
  /** What `←→` does: it steps the choice on whichever row the cursor is standing on. */
  | { input: 'stepChoice'; delta: number }
  | { input: 'chooseAgent'; agentId: SessionAgentId }
  /** Every answer names the computer it is ABOUT: a card left and reopened has two reads in flight. */
  | {
      input: 'agentsDescribed'
      remoteEndpointId: string
      agents: readonly RemoteControlAgentDto[]
    }
  /** `refused` where that computer never offered the operation; anything else may be asked again. */
  | {
      input: 'agentsDescribeFailed'
      remoteEndpointId: string
      refused: boolean
      detail: string
    }
  | { input: 'retryDescribe' }
  | { input: 'chooseModel'; modelId: string | null }
  | { input: 'chooseExistingAgent'; agentId: ExistingAgentFilter }
  | { input: 'cycleAgent' }
  | { input: 'chooseIsolation'; worktree: boolean }
  | { input: 'toggleWorktree' }
  | { input: 'nameChanged'; name: string }
  | { input: 'nameFocus' }
  | {
      input: 'existingSessionsLoaded'
      categoryId: string
      projectName: string
      summaries: readonly ExistingSessionSummary[]
    }
  | {
      input: 'existingSessionsFailed'
      categoryId: string
      projectName: string
      detail: string
    }
  | {
      input: 'remoteSessionsLoaded'
      projectPath: string
      sessions: readonly RemoteExistingSession[]
    }
  | { input: 'remoteSessionsFailed'; projectPath: string; detail: string }
  /** The chosen computer dropped off the snapshot while this card was open. */
  | { input: 'targetLost' }
  | { input: 'setExistingCursor'; index: number }
  | { input: 'activate' }
  | {
      input: 'submitFailed'
      code: string
      detail: string
      setup?: SessionSetupAgreement
      /**
       * Present only when the answer was UNCERTAIN and the same request may be sent again: what
       * that attempt sent. Every definitive refusal leaves it out, and the next attempt then builds
       * its own request with an id of its own.
       */
      retryCreate?: { operationId: string; spec: SessionCreateSpec }
    }
  | { input: 'acknowledgeSetup' }
  | { input: 'escape' }

export type CreateScreenEffect =
  /** Reads the next number without taking it, so a card that is opened and abandoned costs nothing. */
  | { effect: 'fetchNumber'; projectPath: string }
  /**
   * The number is NOT in this effect. Taking it is a write, and the overlay does it immediately
   * before the create so the title and the slug are both built from what was actually allocated
   * rather than from what the placeholder happened to show.
   */
  | { effect: 'submit' }
  | {
      effect: 'fetchExistingSessions'
      categoryId: string
      projectName: string
      projectPath: string
    }
  /** The same question of a remote card, answered from the snapshot that computer already pushed. */
  | { effect: 'fetchRemoteSessions'; remoteEndpointId: string; projectPath: string }
  /** What that computer can start an agent on. Its own catalog: this one's would name the wrong CLIs. */
  | { effect: 'describeAgents'; remoteEndpointId: string }
  | { effect: 'openHistory'; spec: SessionHistoryOpenSpec }
  /**
   * Continue on a remote card: a running session only needs its tab drawing here, and an ended one
   * is asked to reopen on the target first. The same two steps the row of the tree takes.
   */
  | {
      effect: 'openRemoteSession'
      remoteEndpointId: string
      sessionId: string
      tabTitle: string
      running: boolean
    }
  | { effect: 'openFlow'; flowId: string }
  /**
   * Branch one named session. The name travels and nothing else does: what a fork IS - which agent,
   * which conversation, which directory, which number pair - is read off that session's record by
   * the library, and a card that composed it would be a second place that knows what forking means.
   */
  | { effect: 'forkSession'; sessionId: string; name: string }
  /**
   * Bring one named session back. Nothing travels but its id and the name of a tab for it: a resume
   * founds no session, so nothing comes back carrying one, and the tab is what a person watches it
   * come back in.
   */
  | { effect: 'resumeSession'; sessionId: string; tabTitle: string }
  | { effect: 'back' }

export interface CreateScreenStep {
  state: CreateScreenState
  effects: readonly CreateScreenEffect[]
}

/**
 * The second screen of the launcher: what starts, and how.
 *
 * It is one form for starting work and returning to it. Most types ask for a name and isolation;
 * Continue/Fork replaces those rows with the project's existing conversations and lets Agent act as
 * their provider filter.
 *
 * For new work, no option can block the way out: outside the name field, Enter submits even when the
 * number never arrived. Continue/Fork instead needs a selected provider row, so loading and an empty
 * filtered list disable that one action in words.
 */
export class CreateScreenModel {
  static opened(
    binding: LauncherBinding,
    options?: {
      tabProfile?: true
      agentId?: SessionAgentId
      target?: LauncherTarget
      /** What the name field opens holding, from the session this card was opened beside. */
      name?: string
      source?: CreateSessionTarget
    },
  ): CreateScreenStep {
    const tabProfile = options?.tabProfile === true
    const target: LauncherTarget = options?.target ?? { kind: 'local' }
    const source = options?.source ?? null
    const state: CreateScreenState = {
      binding,
      target,
      tabProfile,
      // The name is the one answer nobody else can give: every other row opens on what is wanted
      // most of the time, so the card opens ready to be typed into and `↓` leaves the field. A
      // resume asks for no name, so there the cursor opens on the list, standing on its session.
      field: options?.source?.mode === 'resume' ? 'existingSessions' : 'name',
      typeIndex: 0,
      agentId: options?.agentId ?? 'claude',
      source,
      models: { status: 'none' },
      modelId: null,
      existingAgentFilter: 'all',
      existingSessions: null,
      remoteSessions: null,
      existingSessionsError: null,
      existingCursor: 0,
      name: options?.name ?? '',
      token: null,
      worktree: false,
      submitError: null,
      acknowledgeSetup: null,
      pendingCreate: null,
      targetLost: false,
      submitting: false,
    }
    // A number is a project's own running count, kept by the machine that holds the project. Asking
    // this one for it would put a count of local work in the title of a session on another computer.
    const endpoint = CreateScreenModel.endpointOf(target)
    if (endpoint !== null)
      return CreateScreenModel.step(
        { ...state, models: { status: 'loading' } },
        { effect: 'describeAgents', remoteEndpointId: endpoint },
      )
    const effects: CreateScreenEffect[] = []
    // A tab is not counted: a number is a project's running count of the work done in it, and a tab
    // is not work the tree is keeping. Continue/Fork from this profile does land in the tree, but it
    // takes the number the conversation already has rather than one peeked here. Only a catalog
    // project is counted at all: the other two bindings name a directory, not a project.
    if (!tabProfile && binding.mode === 'project')
      effects.push({ effect: 'fetchNumber', projectPath: binding.projectPath })
    // Opened on a session: Continue/Fork leads and opens chosen, so its list is read now rather
    // than when somebody walks onto the type.
    if (source !== null && binding.mode === 'project')
      effects.push({
        effect: 'fetchExistingSessions',
        categoryId: binding.categoryId,
        projectName: binding.projectName,
        projectPath: binding.projectPath,
      })
    // A binding with no project has no list to read, and the session's own row is the whole list
    // there. Saying that outright is what stops the card drawing `Loading sessions…` under a fetch
    // that is never made.
    if (source !== null && binding.mode !== 'project')
      return CreateScreenModel.step({ ...state, existingSessions: [] }, ...effects)
    return CreateScreenModel.step(state, ...effects)
  }

  /**
   * Raw, the catalog's flows, Continue/Fork, and Shell last - except on a card opened ON a session,
   * where Continue/Fork leads instead.
   *
   * It leads there because the type row opens on its first entry and that is the type the command
   * asked for: the answer somebody came for is the one already chosen. Everything else stays in the
   * list, so the same card still says "actually, a fresh one in the same place" without being
   * closed and reopened.
   *
   * The tab profile offers the same types minus the flows: a flow composes work the tree keeps, and
   * a card whose whole premise is the short question has no room to configure one. Nothing else is
   * withheld - the list is shorter, never a different vocabulary.
   */
  static typesOf(profile: {
    tabProfile: boolean
    target: LauncherTarget
    source: CreateSessionTarget | null
  }): readonly CreateType[] {
    const types: readonly CreateType[] =
      profile.tabProfile || CreateScreenModel.endpointOf(profile.target) !== null
        ? CreateScreenModel.shortTypesConst
        : [
            { kind: 'raw' },
            ...FlowCatalog.flows().map((flow): CreateType => ({ kind: 'flow', flowId: flow.id })),
            { kind: 'existing' },
            { kind: 'shell' },
          ]
    if (profile.source === null) return types
    return [{ kind: 'existing' }, ...types.filter((type) => type.kind !== 'existing')]
  }

  static typeOf(state: CreateScreenState): CreateType {
    const type = CreateScreenModel.typesOf(state)[state.typeIndex]
    if (!type) throw new Error(`No type at index ${state.typeIndex}`)
    return type
  }

  static transition(state: CreateScreenState, input: CreateScreenInput): CreateScreenStep {
    if (input.input === 'existingSessionsLoaded') {
      if (!CreateScreenModel.historyAnswerIsFor(state, input)) return CreateScreenModel.step(state)
      return CreateScreenModel.withExistingCursor({
        ...state,
        existingSessions: input.summaries,
        existingSessionsError: null,
      }, state.existingCursor)
    }
    else if (input.input === 'existingSessionsFailed') {
      if (!CreateScreenModel.historyAnswerIsFor(state, input)) return CreateScreenModel.step(state)
      return CreateScreenModel.step({
        ...state,
        existingSessions: [],
        existingSessionsError: input.detail,
        existingCursor: 0,
      })
    }
    else if (input.input === 'remoteSessionsLoaded') {
      if (!CreateScreenModel.remoteAnswerIsFor(state, input)) return CreateScreenModel.step(state)
      return CreateScreenModel.withExistingCursor({
        ...state,
        remoteSessions: input.sessions,
        existingSessionsError: null,
      }, state.existingCursor)
    }
    else if (input.input === 'remoteSessionsFailed') {
      if (!CreateScreenModel.remoteAnswerIsFor(state, input)) return CreateScreenModel.step(state)
      return CreateScreenModel.step({
        ...state,
        remoteSessions: [],
        existingSessionsError: input.detail,
        existingCursor: 0,
      })
    }
    else if (input.input === 'targetLost')
      // A submit that was out when the connection went is not cancelled by this: its answer is
      // uncertain and arrives on its own, which is the state the Retry is offered from.
      return CreateScreenModel.step({ ...state, targetLost: true })
    else if (input.input === 'numberLoaded') {
      // A peek that answers for a project this card is no longer showing is a late answer, not
      // a number: drawn here it would name another project's count beside this one's name, and
      // the branch preview would build a slug out of it.
      const binding = state.binding
      if (binding.mode !== 'project' || binding.projectPath !== input.projectPath)
        return CreateScreenModel.step(state)
      return CreateScreenModel.step({ ...state, token: input.token })
    }
    else if (input.input === 'moveField') return CreateScreenModel.movedField(state, input.delta)
    else if (input.input === 'setField')
      return CreateScreenModel.step({ ...state, field: input.field })
    else if (input.input === 'chooseType') return CreateScreenModel.typed(state, input.index)
    else if (input.input === 'stepChoice') return CreateScreenModel.stepped(state, input.delta)
    else if (input.input === 'chooseAgent') return CreateScreenModel.agented(state, input.agentId)
    else if (input.input === 'agentsDescribed') {
      if (!CreateScreenModel.describeAnswerIsFor(state, input)) return CreateScreenModel.step(state)
      return CreateScreenModel.step({
        ...state,
        models: { status: 'ready', agents: input.agents },
      })
    }
    else if (input.input === 'agentsDescribeFailed') {
      if (!CreateScreenModel.describeAnswerIsFor(state, input)) return CreateScreenModel.step(state)
      return CreateScreenModel.step({
        ...state,
        models: input.refused
          ? { status: 'refused' }
          : { status: 'unreachable', detail: input.detail },
        // Whatever was chosen was chosen from an offer that is no longer standing.
        modelId: null,
      })
    }
    else if (input.input === 'retryDescribe') return CreateScreenModel.retriedDescribe(state)
    else if (input.input === 'chooseModel') return CreateScreenModel.modelled(state, input.modelId)
    else if (input.input === 'chooseExistingAgent')
      return CreateScreenModel.existingAgented(state, input.agentId)
    else if (input.input === 'cycleAgent') return CreateScreenModel.cycledAgent(state)
    else if (input.input === 'chooseIsolation')
      return CreateScreenModel.isolated(state, input.worktree)
    else if (input.input === 'toggleWorktree')
      return CreateScreenModel.isolated(state, !state.worktree)
    else if (input.input === 'nameChanged')
      return CreateScreenModel.named(state, input.name)
    else if (input.input === 'nameFocus')
      return CreateScreenModel.fieldsOf(state).includes('name')
        ? CreateScreenModel.step({ ...state, field: 'name' })
        : CreateScreenModel.step(state)
    else if (input.input === 'setExistingCursor')
      return CreateScreenModel.withExistingCursor(
        { ...state, field: 'existingSessions' }, input.index)
    else if (input.input === 'activate') return CreateScreenModel.activated(state)
    else if (input.input === 'submitFailed')
      return CreateScreenModel.step({
        ...state,
        submitting: false,
        submitError: { code: input.code, detail: input.detail, setup: input.setup },
        // An answer that was refused is not an answer to whatever is asked next.
        acknowledgeSetup: null,
        // Kept only where the caller said the outcome is unknown. A definitive refusal clears it,
        // so the next attempt is a new operation rather than a replay of a decided one.
        pendingCreate: input.retryCreate ?? null,
      })
    else if (input.input === 'acknowledgeSetup') return CreateScreenModel.acknowledged(state)
    else if (input.input === 'escape') {
      // Nothing while a submit is out. The success path calls `openTerminal` and `close` whatever
      // screen is up, so backing out of a slow create - a worktree plus an install, with nothing
      // apparently happening - opened a tab for a session the person believed they had cancelled,
      // and a second Enter in that window made it two sessions with two numbers. The footer
      // already says "Starting…", which is what a screen that cannot be left has to say.
      if (state.submitting) return CreateScreenModel.step(state)
      return CreateScreenModel.step(state, { effect: 'back' })
    }
    else
      throw new Error(`Unknown create screen input: ${JSON.stringify(input)}`)
  }

  /**
   * The one place a spec is built, and the token arrives as a PARAMETER rather than out of the state:
   * the title and the branch must both come from the number that was actually allocated, never from
   * the one the placeholder was showing while the form was being filled in.
   */
  static specOf(state: CreateScreenState, token: string | null): SessionCreateSpec {
    const title = CreateScreenModel.titleOf(state, token)
    const type = CreateScreenModel.typeOf(state)
    const worktree = state.worktree && title !== undefined ? { slug: title } : undefined
    const acknowledgeSetup = state.acknowledgeSetup ?? undefined
    /*
     * The PROFILE decides the presentation and the TYPE decides the rest. Both types that reach this
     * method from the tab card - `raw` and `shell` - are drawn by their tab alone; Continue/Fork
     * never arrives here, because an existing conversation is opened through `openHistorySpecOf` and
     * stays a session of the tree. An empty name leaves the title to the library, which names it
     * after the directory.
     */
    const presentation = state.tabProfile ? ('tab' as const) : undefined
    if (type.kind === 'shell')
      return {
        kind: 'shell',
        directory: CreateScreenModel.directoryOf(state.binding),
        title,
        worktree,
        acknowledgeSetup,
        presentation,
      }
    else if (type.kind === 'raw' || type.kind === 'flow') {
      const model = CreateScreenModel.chosenModelOf(state)
      return {
        kind: 'agent',
        directory: CreateScreenModel.directoryOf(state.binding),
        title,
        agent: {
          agentId: state.agentId,
          mode: 'new',
          ...(model === undefined ? {} : { model }),
        },
        worktree,
        acknowledgeSetup,
        presentation,
      }
    }
    else if (type.kind === 'existing')
      throw new Error('An existing conversation is opened through openHistorySpecOf')
    else
      throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
  }

  static openHistorySpecOf(
    state: CreateScreenState,
    summary: ExistingSessionSummary,
  ): SessionHistoryOpenSpec {
    if (state.binding.mode !== 'project')
      throw new Error('An existing conversation needs a catalog project')
    return {
      directory: {
        mode: 'project',
        categoryId: state.binding.categoryId,
        projectPath: state.binding.projectPath,
      },
      agentId: summary.agentId,
      nativeSessionId: summary.nativeSessionId,
      providerName: LauncherLabels.summaryLabelOf(summary),
      providerActive: summary.active,
    }
  }

  /**
   * The fixed prefix the name field is drawn behind, which for a fork is the number PAIR: a fork
   * keeps its parent's number on the left and spends its own on the right, and it is `SessionTitle`
   * that says so - the library composes the real title the same way, from the number it actually
   * takes. Null while no number has been read, and for a binding that has none to read.
   */
  static tokenLabelOf(state: CreateScreenState): string | null {
    if (state.token === null) return null
    // What the cursor stands on decides it, not what the card was opened for: moved off that row or
    // off the list, this is an ordinary new session here and takes an ordinary number.
    const acting = CreateScreenModel.actingOn(state)
    if (acting === null || acting.mode !== 'fork') return state.token
    return SessionTitle.composeFork(acting.number, state.token, '')
  }

  /**
   * What the title will be. The number is the prefix by construction, which is what lets the store
   * read the count back out of the records without a field of its own.
   */
  static titleOf(state: CreateScreenState, token: string | null): string | undefined {
    const name = state.name.trim()
    if (token === null) return name.length === 0 ? undefined : name
    return name.length === 0 ? token : `${token} - ${name}`
  }

  /** The branch and the directory this would land on, drawn before anything is created. */
  static worktreePreviewOf(
    state: CreateScreenState,
    token: string | null,
  ): { slug: string; branch: string; path: string } | null {
    const title = CreateScreenModel.titleOf(state, token)
    if (title === undefined || state.binding.mode !== 'project') return null
    const slug = WorktreeNaming.slugOf(title)
    if (slug.length === 0) return null
    // The separator the project path is already written with, rather than one typed here: the
    // same preview is drawn for whatever the catalog holds.
    const separator = state.binding.projectPath.includes('\\') ? '\\' : '/'
    return {
      slug,
      branch: WorktreeNaming.branchOf(slug),
      path: [state.binding.projectPath, WorktreeNaming.folderNameConst, slug].join(separator),
    }
  }

  /**
   * Which computer this card sends to, null being this one. The ONE place a target becomes an
   * endpoint, so a kind nobody has decided about throws here rather than passing as local - which
   * is the case where a session is founded on the wrong machine and nothing says so.
   */
  static endpointOf(target: LauncherTarget): string | null {
    if (target.kind === 'local') return null
    else if (target.kind === 'remote') return target.remoteEndpointId
    else
      throw new Error(`Unknown launcher target: ${JSON.stringify(target)}`)
  }

  /**
   * The model that travels with the spec, and the ONE gate that decides whether one does.
   *
   * A model reaches the wire only from a target that ANSWERED `agents.describe`, because that
   * answer is the proof the target's create validator knows the key at all - an older one reads
   * exact keys and refuses the whole request over it, so a hopeful send would break the create
   * rather than degrade it. Left at "target default", nothing travels and the target composes the
   * model from its own settings, which is exactly what it did before this row existed.
   */
  static chosenModelOf(state: CreateScreenState): string | undefined {
    if (CreateScreenModel.endpointOf(state.target) === null) return undefined
    if (state.models.status !== 'ready') return undefined
    return state.modelId ?? undefined
  }

  /**
   * The picker as the TARGET describes it: its own catalog, its own configured value named on the
   * default line, and - where that value is one its catalog no longer lists - a bare extra entry.
   * Hiding it would draw something else as chosen while the target still starts on it.
   */
  static modelOptionsOf(state: CreateScreenState): readonly CreateModelOption[] {
    const models = state.models
    if (models.status !== 'ready') return []
    const agent = models.agents.find((entry) => entry.agentId === state.agentId)
    if (agent === undefined) return []
    const options: CreateModelOption[] = [{
      id: null,
      label: agent.configuredModel === null
        ? 'Target default'
        : `Target default (${agent.configuredModel})`,
      note: null,
    }]
    for (const model of agent.models)
      options.push({ id: model.id, label: model.label, note: model.note ?? null })
    if (agent.configuredModel !== null
      && !agent.models.some((model) => model.id === agent.configuredModel))
      options.push({ id: agent.configuredModel, label: agent.configuredModel, note: null })
    return options
  }

  /** The remark under the row for whatever is chosen, or null where there is nothing to add. */
  static modelNoteOf(state: CreateScreenState): string | null {
    return CreateScreenModel.modelOptionsOf(state)
      .find((option) => option.id === state.modelId)?.note ?? null
  }

  /**
   * Why the model row cannot be used, in words. Never silence: a picker that is simply absent reads
   * as a feature that was forgotten, and the whole point of the capability gate is that the person
   * is told the target starts on its own model rather than on one they thought they picked.
   */
  static modelRefusal(state: CreateScreenState): string | null {
    if (CreateScreenModel.endpointOf(state.target) === null) return null
    if (CreateScreenModel.typeOf(state).kind === 'shell') return 'a shell runs no agent'
    const name = CreateScreenModel.targetNameOf(state.target)
    const models = state.models
    if (models.status === 'none' || models.status === 'loading')
      return `asking ${name} which models it offers`
    else if (models.status === 'refused')
      return `${name} does not offer model selection; it starts on the model it has configured`
    else if (models.status === 'unreachable')
      return `${name} could not be asked which models it offers (${models.detail})`
    else if (models.status === 'ready')
      return CreateScreenModel.modelOptionsOf(state).length === 0
        ? `${name} named no models for this agent`
        : null
    else
      throw new Error(`Unknown models state: ${JSON.stringify(models)}`)
  }

  /** Whether asking again is worth offering: a refusal is that target's answer for good. */
  static modelRetryable(state: CreateScreenState): boolean {
    return state.models.status === 'unreachable'
  }

  /** What this card calls the computer it starts on, for the sentences above. */
  static targetNameOf(target: LauncherTarget): string {
    if (target.kind === 'local') return 'This computer'
    else if (target.kind === 'remote') return target.displayName
    else
      throw new Error(`Unknown launcher target: ${JSON.stringify(target)}`)
  }

  /**
   * What a remote card does NOT offer, said out loud. Every one of these is a row the local card has
   * and this one does not draw at all, and a form that is simply shorter than the one somebody knows
   * reads as a form that lost something rather than as one that was decided.
   */
  static remoteRefusals(state: CreateScreenState): readonly string[] {
    if (CreateScreenModel.endpointOf(state.target) === null) return []
    return [
      'Flows run where they were defined; this card starts on another computer.',
      'A plain tab lives outside the tree; the remote card starts tree sessions only.',
      'Worktree isolation is set up on the target; use the CLI --worktree for now.',
      'The number belongs to that project on that computer, which names the session itself.',
      'The session opens in a tab here; nothing is opened on the target\'s own screen.',
    ]
  }

  /**
   * A worktree needs a project, and it needs something to be named after. The second one is not
   * pedantry: with no number and no name the slug comes out empty, and git refuses it one step later
   * with a message about slugs rather than about this screen.
   */
  static worktreeRefusal(state: CreateScreenState): string | null {
    if (CreateScreenModel.endpointOf(state.target) !== null)
      return 'worktree isolation is set up on the target computer'
    if (state.tabProfile) return 'a tab runs without isolation'
    // The same rule the library keeps: a session opened out of this list runs where it already
    // runs, and a worktree belongs to the one session it was cut for.
    if (CreateScreenModel.typeOf(state).kind === 'existing')
      return 'an existing conversation runs in its project'
    if (state.binding.mode !== 'project') return 'a worktree needs a catalog project'
    if (CreateScreenModel.worktreePreviewOf(state, state.token) === null)
      return 'a worktree needs a name to be called after'
    return null
  }

  /** Disabled and said out loud rather than hidden: a shell has nobody to be an agent for. */
  static agentRefusal(state: CreateScreenState): string | null {
    if (CreateScreenModel.typeOf(state).kind === 'shell') return 'a shell runs no agent'
    return null
  }

  static typeRefusal(state: CreateScreenState, type: CreateType): string | null {
    if (type.kind !== 'existing') return null
    // The session the card was opened on is a row of that list wherever it runs, so the type is
    // choosable even where the project's own list cannot be read at all.
    if (state.source !== null) return null
    return state.binding.mode === 'project'
      ? null
      : 'existing sessions need a catalog project'
  }

  static existingRowsOf(state: CreateScreenState): readonly ExistingSessionSummary[] {
    return (state.existingSessions ?? []).filter((summary) =>
      state.existingAgentFilter === 'all' || summary.agentId === state.existingAgentFilter)
  }

  /** The target's own sessions in this project, under the same agent filter as the local list. */
  static remoteSessionRowsOf(state: CreateScreenState): readonly RemoteExistingSession[] {
    return (state.remoteSessions ?? []).filter((session) =>
      state.existingAgentFilter === 'all' || session.agentId === state.existingAgentFilter)
  }

  /**
   * The project's conversations minus the one the card's own row already stands for. The session a
   * card is opened on is usually in this list too, and drawing it twice would offer one
   * conversation as two rows that do different things.
   */
  private static localSummariesOf(state: CreateScreenState): readonly ExistingSessionSummary[] {
    const source = state.source
    const rows = CreateScreenModel.existingRowsOf(state)
    if (source === null) return rows
    return rows.filter((summary) =>
      summary.agentId !== source.agentId || summary.nativeSessionId !== source.nativeSessionId)
  }

  /**
   * The row for the session this card was opened on, or null on a card that was opened on none.
   *
   * It ignores the agent filter on purpose: the filter picks which of the project's conversations
   * to look through, and this row is not one of them - it is what the card is about.
   */
  private static sourceRowOf(state: CreateScreenState): ExistingRow | null {
    const source = state.source
    if (source === null || CreateScreenModel.endpointOf(state.target) !== null) return null
    return {
      key: `source/${source.sessionId}`,
      label: source.title,
      untitled: false,
      agentId: source.agentId,
      // A fork is offered for a session that is running and a resume for one that has stopped, so
      // the mode already says which, and a second field carrying the same fact could disagree.
      active: source.mode === 'fork',
      times: null,
      mark: 'this session',
    }
  }

  /** What the Continue list DRAWS, from whichever of the two lists the target names. */
  static existingDisplayRowsOf(state: CreateScreenState): readonly ExistingRow[] {
    const endpoint = CreateScreenModel.endpointOf(state.target)
    if (endpoint === null) {
      const rows = CreateScreenModel.localSummariesOf(state).map((summary): ExistingRow => ({
        key: CreateScreenModel.existingRowKeyOf(summary),
        label: summary.localTitle ?? LauncherLabels.summaryLabelOf(summary),
        untitled: summary.localTitle === null
          && summary.title === null && summary.firstUserMessage === null,
        agentId: summary.agentId,
        active: summary.active,
        times: { lastActivity: summary.lastActivity, createdAt: summary.createdAt },
        mark: null,
      }))
      const pinned = CreateScreenModel.sourceRowOf(state)
      return pinned === null ? rows : [pinned, ...rows]
    }
    return CreateScreenModel.remoteSessionRowsOf(state).map((session): ExistingRow => ({
      key: session.sessionId,
      label: session.title.length === 0 ? 'Untitled session' : session.title,
      untitled: session.title.length === 0,
      agentId: session.agentId,
      active: session.running,
      // The target's snapshot carries no provider timestamps, and inventing one from this machine's
      // clock would put a time on the row that nothing measured.
      times: null,
      mark: null,
    }))
  }

  /** What Enter acts on: the row under the cursor, as the thing that row stands for. */
  static existingSelectionOf(state: CreateScreenState): ExistingSelection | null {
    if (CreateScreenModel.endpointOf(state.target) !== null) {
      const session = CreateScreenModel.remoteSessionRowsOf(state)[state.existingCursor]
      return session === undefined ? null : { kind: 'remote', session }
    }
    const source = state.source
    const pinned = CreateScreenModel.sourceRowOf(state)
    if (pinned !== null && source !== null && state.existingCursor === 0)
      return { kind: 'source', source }
    const summary = CreateScreenModel.localSummariesOf(state)[
      pinned === null ? state.existingCursor : state.existingCursor - 1]
    return summary === undefined ? null : { kind: 'summary', summary }
  }

  /**
   * The session this card ACTS on, which is the one it was opened on for as long as its row is the
   * chosen one. Null the moment the cursor moves off that row or the type moves off the list: a
   * card left on Raw starts a fresh session, and one standing on another conversation continues
   * that conversation.
   */
  static actingOn(state: CreateScreenState): CreateSessionTarget | null {
    if (CreateScreenModel.typeOf(state).kind !== 'existing') return null
    const selection = CreateScreenModel.existingSelectionOf(state)
    return selection?.kind === 'source' ? selection.source : null
  }

  /** Why the Continue list is empty, or null while it has rows. */
  static existingEmptyMessage(state: CreateScreenState): string | null {
    if (!CreateScreenModel.existingLoaded(state)) return null
    if (CreateScreenModel.existingDisplayRowsOf(state).length > 0) return null
    const unfiltered = CreateScreenModel.existingDisplayRowsOf(
      { ...state, existingAgentFilter: 'all' })
    return unfiltered.length === 0
      ? 'Nobody has worked in this project yet.'
      : `No ${state.existingAgentFilter} sessions in this project.`
  }

  /** Whether the list has been read at all, which is not the same as its being empty. */
  static existingLoaded(state: CreateScreenState): boolean {
    return CreateScreenModel.endpointOf(state.target) === null
      ? state.existingSessions !== null
      : state.remoteSessions !== null
  }

  static existingRefusal(state: CreateScreenState): string | null {
    if (CreateScreenModel.actingOn(state) !== null) return null
    if (state.binding.mode !== 'project') return 'existing sessions need a catalog project'
    if (!CreateScreenModel.existingLoaded(state)) return 'sessions are loading'
    if (CreateScreenModel.existingDisplayRowsOf(state).length === 0) return 'nothing to continue'
    return null
  }

  static existingRowKeyOf(summary: ExistingSessionSummary): string {
    return `${summary.agentId}/${summary.nativeSessionId}`
  }

  /**
   * The short list, which both reduced profiles ask from: the same types the session card offers,
   * minus the flows. A flow composes work the tree keeps and is defined on the machine it runs on,
   * so neither the tab card nor a card aimed at another computer has one to configure.
   */
  private static readonly shortTypesConst: readonly CreateType[] =
    [{ kind: 'raw' }, { kind: 'existing' }, { kind: 'shell' }]

  private static readonly fieldsConst: readonly CreateField[] =
    ['name', 'type', 'isolation', 'agent']
  /** The same rows minus isolation, which neither reduced profile asks and both refuse in words. */
  private static readonly shortFieldsConst: readonly CreateField[] = ['name', 'type', 'agent']
  /**
   * The remote rows: the tab card's, plus the model. It comes AFTER the agent because it is the
   * agent's - the target answers per agent, and switching agents drops whatever was chosen.
   */
  private static readonly remoteFieldsConst: readonly CreateField[] =
    ['name', 'type', 'agent', 'model']
  private static readonly existingFieldsConst: readonly CreateField[] =
    ['type', 'agent', 'existingSessions']
  /**
   * The same rows plus a name, for the one row of that list that can take one: a fork founds a new
   * session and gets to be called something. Every other row of it opens a session that is already
   * named - a resume brings back the very record, and a continue takes the conversation's own name.
   */
  private static readonly existingForkFieldsConst: readonly CreateField[] =
    ['name', 'type', 'agent', 'existingSessions']

  /** The cursor walks only the rows that are drawn, which is what the screen shows. */
  static fieldsOf(state: CreateScreenState): readonly CreateField[] {
    if (CreateScreenModel.typeOf(state).kind === 'existing')
      return CreateScreenModel.actingOn(state)?.mode === 'fork'
        ? CreateScreenModel.existingForkFieldsConst
        : CreateScreenModel.existingFieldsConst
    if (CreateScreenModel.endpointOf(state.target) !== null)
      return CreateScreenModel.remoteFieldsConst
    if (state.tabProfile) return CreateScreenModel.shortFieldsConst
    return CreateScreenModel.fieldsConst
  }

  private static movedField(state: CreateScreenState, delta: number): CreateScreenStep {
    if (state.field === 'existingSessions') {
      if (delta > 0)
        return CreateScreenModel.withExistingCursor(state, state.existingCursor + 1)
      if (state.existingCursor > 0)
        return CreateScreenModel.withExistingCursor(state, state.existingCursor - 1)
    }
    return CreateScreenModel.step({ ...state, field: CreateScreenModel.fieldAt(state, delta) })
  }

  private static fieldAt(state: CreateScreenState, delta: number): CreateField {
    const fields = CreateScreenModel.fieldsOf(state)
    const at = fields.indexOf(state.field) + delta
    return fields[Math.min(Math.max(at, 0), fields.length - 1)] ?? state.field
  }

  /**
   * `←→` belongs to the row, not to one control: the same keystroke picks a type, an isolation or an
   * agent depending on where the cursor is. On the name row it does nothing, because there the
   * arrows belong to the text.
   */
  private static stepped(state: CreateScreenState, delta: number): CreateScreenStep {
    if (state.field === 'name') return CreateScreenModel.step(state)
    else if (state.field === 'type')
      return CreateScreenModel.typed(state, state.typeIndex + delta, true)
    else if (state.field === 'isolation')
      return CreateScreenModel.isolated(state, delta > 0)
    else if (state.field === 'agent')
      return CreateScreenModel.typeOf(state).kind === 'existing'
        ? CreateScreenModel.steppedExistingAgent(state, delta)
        : CreateScreenModel.agented(state, delta > 0 ? 'codex' : 'claude')
    else if (state.field === 'model') return CreateScreenModel.steppedModel(state, delta)
    else if (state.field === 'existingSessions') return CreateScreenModel.step(state)
    else
      throw new Error(`Unknown create field: ${JSON.stringify(state.field)}`)
  }

  private static typed(
    state: CreateScreenState,
    index: number,
    skipRefused = false,
  ): CreateScreenStep {
    const types = CreateScreenModel.typesOf(state)
    let selected = Math.min(Math.max(index, 0), types.length - 1)
    const direction = Math.sign(selected - state.typeIndex)
    while (selected !== state.typeIndex) {
      const candidate = types[selected]
      if (!candidate) return CreateScreenModel.step(state)
      if (CreateScreenModel.typeRefusal(state, candidate) === null) break
      if (!skipRefused || direction === 0) return CreateScreenModel.step(state)
      selected += direction
      if (selected < 0 || selected >= types.length) return CreateScreenModel.step(state)
    }
    const previous = CreateScreenModel.typeOf(state)
    const nextType = types[selected]
    if (!nextType) return CreateScreenModel.step(state)
    const next: CreateScreenState = { ...state, typeIndex: selected, field: 'type' }
    if (nextType.kind !== 'existing' || previous.kind === 'existing')
      return CreateScreenModel.step(next)
    next.existingAgentFilter = 'all'
    next.existingCursor = 0
    if (CreateScreenModel.existingLoaded(next) || next.existingSessionsError !== null)
      return CreateScreenModel.step(next)
    if (next.binding.mode !== 'project') return CreateScreenModel.step(next)
    const endpoint = CreateScreenModel.endpointOf(next.target)
    if (endpoint !== null)
      return CreateScreenModel.step(next, {
        effect: 'fetchRemoteSessions',
        remoteEndpointId: endpoint,
        projectPath: next.binding.projectPath,
      })
    return CreateScreenModel.step(next, {
      effect: 'fetchExistingSessions',
      categoryId: next.binding.categoryId,
      projectName: next.binding.projectName,
      projectPath: next.binding.projectPath,
    })
  }

  private static agented(
    state: CreateScreenState,
    agentId: SessionAgentId,
  ): CreateScreenStep {
    if (CreateScreenModel.typeOf(state).kind === 'existing')
      return CreateScreenModel.step(state)
    if (CreateScreenModel.agentRefusal(state) !== null) return CreateScreenModel.step(state)
    // The target answers per agent, so a model chosen for one is not a model the other has.
    return CreateScreenModel.step({ ...state, agentId, modelId: null, field: 'agent' })
  }

  /** Only an id the target actually offered: anything else is a model chosen from a stale list. */
  private static modelled(state: CreateScreenState, modelId: string | null): CreateScreenStep {
    const next = { ...state, field: 'model' as const }
    if (modelId === null) return CreateScreenModel.step({ ...next, modelId: null })
    if (!CreateScreenModel.modelOptionsOf(state).some((option) => option.id === modelId))
      return CreateScreenModel.step(state)
    return CreateScreenModel.step({ ...next, modelId })
  }

  private static steppedModel(state: CreateScreenState, delta: number): CreateScreenStep {
    const options = CreateScreenModel.modelOptionsOf(state)
    if (options.length === 0) return CreateScreenModel.step(state)
    const at = options.findIndex((option) => option.id === state.modelId)
    const next = options[Math.min(Math.max(at + delta, 0), options.length - 1)]
    if (next === undefined) return CreateScreenModel.step(state)
    return CreateScreenModel.modelled(state, next.id)
  }

  /** Asking again after a target that could not answer. A refusal is its answer and stands. */
  private static retriedDescribe(state: CreateScreenState): CreateScreenStep {
    const endpoint = CreateScreenModel.endpointOf(state.target)
    if (endpoint === null || !CreateScreenModel.modelRetryable(state))
      return CreateScreenModel.step(state)
    return CreateScreenModel.step(
      { ...state, models: { status: 'loading' } },
      { effect: 'describeAgents', remoteEndpointId: endpoint },
    )
  }

  private static existingAgented(
    state: CreateScreenState,
    agentId: ExistingAgentFilter,
  ): CreateScreenStep {
    if (CreateScreenModel.typeOf(state).kind !== 'existing')
      return CreateScreenModel.step(state)
    return CreateScreenModel.withExistingCursor(
      { ...state, existingAgentFilter: agentId, field: 'agent' }, 0)
  }

  private static cycledAgent(state: CreateScreenState): CreateScreenStep {
    if (CreateScreenModel.typeOf(state).kind !== 'existing')
      return CreateScreenModel.agented(state, state.agentId === 'claude' ? 'codex' : 'claude')
    const filters: readonly ExistingAgentFilter[] = ['claude', 'codex', 'all']
    const at = filters.indexOf(state.existingAgentFilter)
    return CreateScreenModel.existingAgented(state, filters[(at + 1) % filters.length] ?? 'all')
  }

  private static steppedExistingAgent(state: CreateScreenState, delta: number): CreateScreenStep {
    const filters: readonly ExistingAgentFilter[] = ['claude', 'codex', 'all']
    const at = filters.indexOf(state.existingAgentFilter)
    const next = Math.min(Math.max(at + delta, 0), filters.length - 1)
    return CreateScreenModel.existingAgented(state, filters[next] ?? 'all')
  }

  private static isolated(state: CreateScreenState, worktree: boolean): CreateScreenStep {
    if (CreateScreenModel.typeOf(state).kind === 'existing')
      return CreateScreenModel.step(state)
    // Turning it OFF is never refused: whatever the reason it cannot be on, off is always reachable.
    if (worktree && CreateScreenModel.worktreeRefusal(state) !== null)
      return CreateScreenModel.step(state)
    return CreateScreenModel.step({ ...state, worktree, field: 'isolation' })
  }

  /** A name that stops being one takes the worktree with it, rather than leaving an empty slug. */
  private static named(state: CreateScreenState, name: string): CreateScreenStep {
    const next = { ...state, name }
    if (next.worktree && CreateScreenModel.worktreeRefusal(next) !== null)
      return CreateScreenModel.step({ ...next, worktree: false })
    return CreateScreenModel.step(next)
  }

  /**
   * Agreeing is submitting: the same form, with the hash that was on screen. It is deliberately not
   * a stored preference here - the library remembers it, and this state carries the answer only as
   * far as the call it answers.
   */
  private static acknowledged(state: CreateScreenState): CreateScreenStep {
    const hash = state.submitError?.setup?.hash
    if (hash === undefined) return CreateScreenModel.step(state)
    // A new id, because the body is not the one that was refused: `setup-not-acknowledged` is a
    // decided answer, and replaying its id with a different body is what the far side calls a
    // conflict.
    return CreateScreenModel.activated({
      ...state,
      acknowledgeSetup: hash,
      submitError: null,
      pendingCreate: null,
    })
  }

  private static activated(state: CreateScreenState): CreateScreenStep {
    if (state.submitting || state.targetLost) return CreateScreenModel.step(state)
    const type = CreateScreenModel.typeOf(state)
    // A flow is configured before it starts, so its Enter opens a form instead of creating anything.
    if (type.kind === 'flow')
      return CreateScreenModel.step(state, { effect: 'openFlow', flowId: type.flowId })
    else if (type.kind === 'existing') {
      const selection = CreateScreenModel.existingSelectionOf(state)
      // An empty list, or one still being read: the button says so and this is the key doing the
      // same nothing.
      if (selection === null) return CreateScreenModel.step(state)
      const submitting = { ...state, submitting: true, submitError: null }
      if (selection.kind === 'source')
        return CreateScreenModel.step(
          submitting,
          selection.source.mode === 'fork'
            ? {
                effect: 'forkSession',
                sessionId: selection.source.sessionId,
                name: state.name.trim(),
              }
            : {
                effect: 'resumeSession',
                sessionId: selection.source.sessionId,
                tabTitle: selection.source.tabTitle,
              },
        )
      else if (selection.kind === 'remote') {
        const endpoint = CreateScreenModel.endpointOf(state.target)
        // The remote row is drawn from the target's own list, so a null endpoint here is a row
        // nobody could have built.
        if (endpoint === null) throw new Error('A target session was chosen on a local card')
        return CreateScreenModel.step(submitting, {
          effect: 'openRemoteSession',
          remoteEndpointId: endpoint,
          sessionId: selection.session.sessionId,
          tabTitle: selection.session.tabTitle,
          running: selection.session.running,
        })
      }
      else if (selection.kind === 'summary')
        return CreateScreenModel.step(submitting, {
          effect: 'openHistory',
          spec: CreateScreenModel.openHistorySpecOf(state, selection.summary),
        })
      else
        throw new Error(`Unknown existing selection: ${JSON.stringify(selection)}`)
    }
    else if (type.kind === 'raw' || type.kind === 'shell')
      return CreateScreenModel.step(
        { ...state, submitting: true, submitError: null },
        { effect: 'submit' },
      )
    else
      throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
  }

  private static directoryOf(binding: LauncherBinding): SessionCreateSpec['directory'] {
    if (binding.mode === 'project')
      return { mode: 'project', categoryId: binding.categoryId, projectPath: binding.projectPath }
    else if (binding.mode === 'adHoc')
      return { mode: 'adHoc', path: binding.path }
    else
      throw new Error(`Unknown launcher binding: ${JSON.stringify(binding)}`)
  }

  private static historyAnswerIsFor(
    state: CreateScreenState,
    input: { categoryId: string; projectName: string },
  ): boolean {
    return state.binding.mode === 'project'
      && state.binding.categoryId === input.categoryId
      && state.binding.projectName === input.projectName
  }

  private static remoteAnswerIsFor(
    state: CreateScreenState,
    input: { projectPath: string },
  ): boolean {
    return state.binding.mode === 'project' && state.binding.projectPath === input.projectPath
  }

  /**
   * A describe answers about ONE computer, and a card left for another leaves the first read in
   * flight: drawn without this, a target's catalog would fill the picker of a different one.
   */
  private static describeAnswerIsFor(
    state: CreateScreenState,
    input: { remoteEndpointId: string },
  ): boolean {
    return CreateScreenModel.endpointOf(state.target) === input.remoteEndpointId
  }

  private static withExistingCursor(state: CreateScreenState, index: number): CreateScreenStep {
    const length = CreateScreenModel.existingDisplayRowsOf(state).length
    const cursor = length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1)
    return CreateScreenModel.step({ ...state, existingCursor: cursor })
  }

  private static step(
    state: CreateScreenState,
    ...effects: readonly CreateScreenEffect[]
  ): CreateScreenStep {
    return { state, effects }
  }
}
