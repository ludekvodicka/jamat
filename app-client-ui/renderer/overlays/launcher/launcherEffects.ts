import type {
  ProjectListResult,
  ProjectsOpResult,
  RelocationReport,
} from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  SessionAgentId,
  SessionCreateSpec,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionInfo,
  SessionSetupAgreement,
  SessionsOpResult,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteControlAgentDto,
  RemoteControlError,
  RemoteControlProjectCategoryDto,
  RemoteControlResponse,
} from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../../shared/appClientUiReport'
import { ErrorText } from '../../../shared/errorText'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import type { PanelOpenOutcome } from '../../shell/appShell.types'
import { SessionTabOpener } from '../../shell/sessionTabOpener'
import type {
  ComputersScreenEffect,
  ComputersScreenInput,
} from './computers/computersScreenModel'
import { ComputersScreenModel } from './computers/computersScreenModel'
import type {
  CreateScreenEffect,
  CreateScreenInput,
  CreateScreenState,
  ExistingSessionSummary,
  RemoteExistingSession,
} from './create/createScreenModel'
import { CreateScreenModel } from './create/createScreenModel'
import type { FlowScreenEffect, FlowScreenInput, FlowScreenState } from './flows/flowScreenModel'
import { FlowScreenModel } from './flows/flowScreenModel'
import type { LauncherBinding } from './launcherBinding'
import type { LauncherPrefill } from './launcherIntentStore'
import type { LauncherRemoteTarget } from './launcherTarget'
import type { LauncherEffect, LauncherInput, LauncherSort } from './projects/launcherModel'
import type { ManageEffect, ManageInput } from './projects/manageModel'

/** The two answers a history read can give, each naming the project it is an answer ABOUT. */
type HistoryRead = Extract<
  CreateScreenInput,
  { input: 'existingSessionsLoaded' | 'existingSessionsFailed' }
>

/** What a remote answer that succeeded carries, before anything has decided which operation it is. */
type RemoteResponseValue = Extract<RemoteControlResponse, { ok: true }>['value']

type SubmitFailed = Extract<CreateScreenInput, { input: 'submitFailed' }>

export interface LauncherPorts {
  dispatch(input: LauncherInput): void
  manage(input: ManageInput): void
  create(input: CreateScreenInput): void
  computers(input: ComputersScreenInput): void
  flow(input: FlowScreenInput): void
  /** A flow is configured before it starts, so its row opens a form rather than creating anything. */
  openFlow(flowId: string, options: CreateScreenState): void
  /** Back out of a flow: the create screen returns holding exactly what it was holding. */
  showCreate(options: CreateScreenState): void
  /**
   * Where a session would run, decided on the first screen and answered by the overlay. `prefill`
   * is what a SESSION row knew on top of that - the name, the agent, the conversation to fork - and
   * it is absent whenever the place is all anybody said.
   */
  chooseBinding(binding: LauncherBinding, prefill?: LauncherPrefill): void
  /** Which computer the rest of the card is about, answered by its first screen. */
  chooseComputer(target: LauncherRemoteTarget): void
  showProjects(): void
  showComputers(): void
  /** Where a computer this card does NOT list is explained. Closes the card: one overlay at a time. */
  openRemoteSettings(): void
  /**
   * A created session is invisible until something draws it, and the tab is the only thing that
   * does. It takes a target rather than a session id, because a session founded on another computer
   * is drawn by the same tab and reached through that computer's endpoint.
   */
  openTerminal(
    target: TerminalTarget,
    title: string,
    options?: { plain?: true; preview?: true },
  ): Promise<PanelOpenOutcome>
  markHandedOff(): void
  close(): void
}

/**
 * The overlay's whole conversation with the main process.
 *
 * Two unwraps, always in this order: `IpcResult` says whether the channel answered, and only then
 * does `ProjectsOpResult` say what the library decided. Folding them into one check is how a
 * refused rename starts reading like a broken pipe.
 */
export class LauncherEffects {
  static async loadNewSessionAgent(): Promise<SessionAgentId> {
    const answer = await window.appClient.state.loadNewSessionAgent()
    if (answer.ok) return answer.value
    AppClientUiReport.error(`new-session agent unavailable: ${answer.error}`)
    return 'claude'
  }

  static async saveNewSessionAgent(agentId: SessionAgentId): Promise<void> {
    const answer = await window.appClient.state.saveNewSessionAgent(agentId)
    if (!answer.ok)
      AppClientUiReport.error(`new-session agent not saved: ${answer.error}`)
    else if (!answer.value)
      AppClientUiReport.error('new-session agent was refused by the client state store')
  }

  static async run(effect: LauncherEffect, ports: LauncherPorts): Promise<void> {
    if (effect.effect === 'fetchCategories')
      return effect.remoteEndpointId === null
        ? LauncherEffects.fetchCategories(ports)
        : LauncherEffects.fetchRemoteCatalog(effect.remoteEndpointId, ports)
    else if (effect.effect === 'fetchProjects')
      return effect.remoteEndpointId === null
        ? LauncherEffects.fetchProjects(effect.categoryId, effect.sort, ports)
        : LauncherEffects.fetchRemoteProjects(
            effect.remoteEndpointId, effect.categoryId, effect.sort, ports)
    else if (effect.effect === 'createProject')
      return LauncherEffects.createProject(effect, ports)
    // Enter named a place; what happens to it is the overlay's answer, not the model's.
    else if (effect.effect === 'bindingChosen')
      return ports.chooseBinding(effect.binding)
    else if (effect.effect === 'pickDirectory') return LauncherEffects.pickDirectory(ports)
    else if (effect.effect === 'showComputers') return ports.showComputers()
    else if (effect.effect === 'close') return ports.close()
    else
      throw new Error(`Unknown launcher effect: ${JSON.stringify(effect)}`)
  }

  /** The computer list's I/O: one snapshot read, and two handovers the overlay answers for. */
  static async runComputers(effect: ComputersScreenEffect, ports: LauncherPorts): Promise<void> {
    if (effect.effect === 'fetchComputers') return LauncherEffects.readComputers(ports)
    else if (effect.effect === 'chosen') return ports.chooseComputer(effect.target)
    else if (effect.effect === 'openSettings') return ports.openRemoteSettings()
    else if (effect.effect === 'close') return ports.close()
    else
      throw new Error(`Unknown computers screen effect: ${JSON.stringify(effect)}`)
  }

  /**
   * The connected computers, as the card's first screen draws them. A snapshot that cannot be read
   * is an empty list with the reason reported: this screen has nothing to fall back on, and a card
   * that never draws anything is worse than one that draws its empty state.
   */
  private static async readComputers(ports: LauncherPorts): Promise<void> {
    const answer = await window.appClient.remote.snapshot()
    if (!answer.ok) {
      AppClientUiReport.error(`remote computers unavailable: ${answer.error}`)
      return ports.computers({ input: 'snapshotLoaded', rows: [] })
    }
    ports.computers({
      input: 'snapshotLoaded',
      rows: ComputersScreenModel.rowsOf(answer.value),
    })
  }

  /** The snapshot itself, for the overlay's own watch over the computer this card is aimed at. */
  static async readRemoteSnapshot(): Promise<RemoteConnectionsSnapshot | null> {
    const answer = await window.appClient.remote.snapshot()
    if (!answer.ok) {
      AppClientUiReport.error(`remote snapshot unavailable: ${answer.error}`)
      return null
    }
    return answer.value
  }

  /**
   * The create screen's I/O. It takes the state as well as the effect, because the submit is a
   * two-step: the number is taken here, immediately before the create, so the title and the branch
   * are both built from what was actually allocated rather than from what the form was showing.
   */
  static async runCreate(
    effect: CreateScreenEffect,
    state: CreateScreenState,
    ports: LauncherPorts,
  ): Promise<void> {
    if (effect.effect === 'fetchNumber') return LauncherEffects.peekNumber(effect.projectPath, ports)
    else if (effect.effect === 'submit') return LauncherEffects.startCreate(state, ports)
    else if (effect.effect === 'fetchRemoteSessions')
      return LauncherEffects.readRemoteSessions(
        effect.remoteEndpointId, effect.projectPath, ports)
    else if (effect.effect === 'describeAgents')
      return LauncherEffects.describeRemoteAgents(effect.remoteEndpointId, ports)
    else if (effect.effect === 'openRemoteSession')
      return LauncherEffects.openRemoteSession(effect, ports)
    else if (effect.effect === 'fetchExistingSessions')
      return LauncherEffects.readHistory(
        effect.categoryId,
        effect.projectName,
        effect.projectPath,
        (report) => ports.create(report),
      )
    else if (effect.effect === 'openHistory')
      return LauncherEffects.openHistory(effect.spec, ports)
    else if (effect.effect === 'forkSession')
      return LauncherEffects.forkSession(effect.sessionId, effect.name, ports)
    else if (effect.effect === 'resumeSession')
      return LauncherEffects.resumeSession(effect.sessionId, effect.tabTitle, ports)
    else if (effect.effect === 'openFlow') return ports.openFlow(effect.flowId, state)
    else if (effect.effect === 'back') return ports.showProjects()
    else
      throw new Error(`Unknown create screen effect: ${JSON.stringify(effect)}`)
  }

  /** Reads and takes nothing, so a card that is opened and abandoned costs the project no number. */
  private static async peekNumber(projectPath: string, ports: LauncherPorts): Promise<void> {
    const answer = await window.appClient.sessions.nextNumber(projectPath)
    // Every level of refusal lands in the same place: no number. It is never fatal, and the screen
    // draws a session without one rather than refusing to draw at all.
    //
    // `projectPath` travels back with the answer so the model can tell whether it is still the
    // project being shown. The screen guard in the overlay cannot: it knows a create card is up,
    // not which project's.
    if (!answer.ok || !answer.value.ok)
      return ports.create({ input: 'numberLoaded', projectPath, token: null })
    ports.create({ input: 'numberLoaded', projectPath, token: answer.value.value.token })
  }

  /** Which computer the form is aimed at decides the whole submit, and nothing else does. */
  private static async startCreate(
    state: CreateScreenState,
    ports: LauncherPorts,
  ): Promise<void> {
    const target = state.target
    if (target.kind === 'local') return LauncherEffects.createSession(state, ports)
    else if (target.kind === 'remote')
      return LauncherEffects.createRemoteSession(state, target.remoteEndpointId, ports)
    else
      throw new Error(`Unknown launcher target: ${JSON.stringify(target)}`)
  }

  /**
   * Take the number, then create. A crash between the two burns one number, which is a hole in the
   * count rather than two sessions believing they own the same branch.
   */
  private static async createSession(
    state: CreateScreenState,
    ports: LauncherPorts,
  ): Promise<void> {
    const token = await LauncherEffects.allocateNumber(state)
    return LauncherEffects.startSession(
      CreateScreenModel.specOf(state, token),
      (code, detail, setup) => ports.create({ input: 'submitFailed', code, detail, setup }),
      ports,
    )
  }

  /**
   * The same form, sent to another computer, with the ONE thing that makes a retry safe: the
   * operation id is minted once and then held by the screen, so a second attempt after an answer
   * that never arrived is the same operation to the far side rather than a second session.
   *
   * No number is taken here. A number is a project's own running count, kept by the machine that
   * holds the project, and one taken from this machine would name local work in a remote title.
   */
  private static async createRemoteSession(
    state: CreateScreenState,
    remoteEndpointId: string,
    ports: LauncherPorts,
  ): Promise<void> {
    // The whole request comes back unchanged from an uncertain attempt: the far side refuses the
    // same id with a different body, so the spec cannot be rebuilt from a form somebody has since
    // typed into.
    const pending = state.pendingCreate
      ?? { operationId: crypto.randomUUID(), spec: CreateScreenModel.specOf(state, null) }
    const answer = await window.appClient.remote
      .createSession(remoteEndpointId, pending.spec, pending.operationId)
    // The channel itself failing says nothing about whether the request reached that computer, so
    // it is the most uncertain answer there is and the request is kept for the next press of Enter.
    if (!answer.ok)
      return ports.create({
        input: 'submitFailed',
        code: 'transport',
        detail: answer.error,
        retryCreate: pending,
      })
    if (!answer.value.ok)
      return ports.create(LauncherEffects.remoteFailureOf(answer.value.error, pending))
    const created = LauncherEffects.createdSessionOf(answer.value.value)
    if (created === null)
      return ports.create({
        input: 'submitFailed',
        code: 'invalid-response',
        detail: 'That computer answered the create with something this one cannot read.',
      })
    return LauncherEffects.openRemoteTab(
      remoteEndpointId, created.sessionId, created.tabTitle, ports)
  }

  /**
   * What the target can start an agent on. `forbidden` is the answer that MATTERS: a target that
   * predates the operation never negotiated the capability, so the peer channel refuses this here
   * without a round trip - and that refusal is what stops a `model` from ever being sent to a
   * target whose create validator would refuse the whole request over the key.
   */
  private static async describeRemoteAgents(
    remoteEndpointId: string,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.remote.describeAgents(remoteEndpointId)
    if (!answer.ok)
      return ports.create({
        input: 'agentsDescribeFailed',
        remoteEndpointId,
        refused: false,
        detail: answer.error,
      })
    if (!answer.value.ok)
      return ports.create({
        input: 'agentsDescribeFailed',
        remoteEndpointId,
        refused: answer.value.error.code === 'forbidden',
        detail: answer.value.error.detail,
      })
    const agents = LauncherEffects.describedAgentsOf(answer.value.value)
    if (agents === null)
      return ports.create({
        input: 'agentsDescribeFailed',
        remoteEndpointId,
        refused: false,
        detail: 'That computer answered with something this one cannot read.',
      })
    ports.create({ input: 'agentsDescribed', remoteEndpointId, agents })
  }

  /** The shape check, because this value crossed two processes and a network. */
  private static describedAgentsOf(
    value: RemoteResponseValue,
  ): readonly RemoteControlAgentDto[] | null {
    if (!('agents' in value) || !Array.isArray(value.agents)) return null
    // An entry with no catalog would draw an empty picker as though it were a full one, so it is
    // dropped rather than trusted: an agent the target names is an agent it can list models for.
    return value.agents.filter((agent) =>
      (agent.agentId === 'claude' || agent.agentId === 'codex')
      && (agent.configuredModel === null || typeof agent.configuredModel === 'string')
      && Array.isArray(agent.models))
  }

  /**
   * Continue on a remote card. A running session only needs its tab here; an ended one is asked to
   * reopen on the target first, which is exactly what its row in the tree does.
   */
  private static async openRemoteSession(
    effect: Extract<CreateScreenEffect, { effect: 'openRemoteSession' }>,
    ports: LauncherPorts,
  ): Promise<void> {
    if (!effect.running) {
      const answer = await window.appClient.remote
        .reopenSession(effect.remoteEndpointId, effect.sessionId)
      if (!answer.ok)
        return ports.create({ input: 'submitFailed', code: 'transport', detail: answer.error })
      if (!answer.value.ok)
        return ports.create(LauncherEffects.remoteFailureOf(answer.value.error, null))
    }
    return LauncherEffects.openRemoteTab(
      effect.remoteEndpointId, effect.sessionId, effect.tabTitle, ports)
  }

  /**
   * The tab for a session on another computer. There is no plain-tab cleanup to do: a remote card
   * founds sessions of the tree only, so a tab that fails to open leaves a row on the target rather
   * than a runtime nobody can see.
   */
  private static async openRemoteTab(
    remoteEndpointId: string,
    sessionId: string,
    tabTitle: string,
    ports: LauncherPorts,
  ): Promise<void> {
    const outcome = await ports
      .openTerminal({ kind: 'remote', remoteEndpointId, sessionId }, tabTitle)
      .catch((error: unknown): PanelOpenOutcome => ({
        kind: 'failed',
        detail: ErrorText.of(error),
      }))
    if (outcome.kind === 'opened' || outcome.kind === 'focusedExisting') {
      ports.markHandedOff()
      return ports.close()
    }
    else if (outcome.kind === 'failed')
      return ports.create({ input: 'submitFailed', code: 'panel-open', detail: outcome.detail })
    else
      throw new Error(`Unknown panel open outcome: ${JSON.stringify(outcome)}`)
  }

  /**
   * A flow's submit is the create screen's with one more step in front of it: the flow composes the
   * first instruction, and the number is taken exactly where it is on the create screen.
   */
  static async runFlow(
    effect: FlowScreenEffect,
    state: FlowScreenState,
    ports: LauncherPorts,
  ): Promise<void> {
    if (effect.effect === 'submit') {
      const token = await LauncherEffects.allocateNumber(state.options)
      return LauncherEffects.startSession(
        FlowScreenModel.specOf(state, token),
        (code, detail, setup) => ports.flow({ input: 'submitFailed', code, detail, setup }),
        ports,
      )
    }
    // Back to the create screen rather than to the projects: the flow was opened from a row there,
    // and the answers it carried are still the ones that screen was holding.
    else if (effect.effect === 'back') return ports.showCreate(state.options)
    else
      throw new Error(`Unknown flow screen effect: ${JSON.stringify(effect)}`)
  }

  private static async allocateNumber(state: CreateScreenState): Promise<string | null> {
    // The peek already answered null for a binding that is not a catalog project, and asking again
    // would be a channel call whose answer is known.
    if (state.token === null || state.binding.mode !== 'project') return null
    const answer = await window.appClient.sessions.allocateNumber(state.binding.projectPath)
    if (!answer.ok || !answer.value.ok) return null
    return answer.value.value.token
  }

  static async runManage(effect: ManageEffect, ports: LauncherPorts): Promise<void> {
    // Every relocation names the project it ran on, under the name it had when it started: that is
    // the listing to read again and the summary to throw away, and neither is a question about where
    // the cursor happens to be when the answer lands.
    if (effect.effect === 'rename')
      return LauncherEffects.relocation(
        { categoryId: effect.categoryId, name: effect.oldName },
        window.appClient.projects.rename(effect.categoryId, effect.oldName, effect.newName),
        ports,
      )
    else if (effect.effect === 'movePrefix')
      return LauncherEffects.relocation(
        { categoryId: effect.categoryId, name: effect.name },
        window.appClient.projects.movePrefix(effect.categoryId, effect.name, effect.targetPrefix),
        ports,
      )
    else if (effect.effect === 'archive')
      return LauncherEffects.relocation(
        { categoryId: effect.categoryId, name: effect.name },
        window.appClient.projects.archive(effect.categoryId, effect.name),
        ports,
      )
    else if (effect.effect === 'deletePreview')
      return LauncherEffects.deletePreview(effect.categoryId, effect.name, ports)
    else if (effect.effect === 'deleteExecute') return LauncherEffects.deleteExecute(effect, ports)
    else if (effect.effect === 'refetchProjects')
      return ports.dispatch({ input: 'refetchRequested', categoryId: effect.categoryId })
    else
      throw new Error(`Unknown manage effect: ${JSON.stringify(effect)}`)
  }

  private static async fetchCategories(ports: LauncherPorts): Promise<void> {
    const answer = await window.appClient.projects.categories()
    if (!answer.ok)
      return ports.dispatch({ input: 'loadFailed', detail: answer.error })
    ports.dispatch({ input: 'categoriesLoaded', categories: answer.value })
  }

  private static async fetchProjects(
    categoryId: string,
    sort: LauncherSort,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.projects.list(categoryId, sort)
    const listing = LauncherEffects.listed(answer, (detail) => ports.dispatch({
      input: 'projectsLoadFailed',
      categoryId,
      sort,
      detail,
    }))
    if (listing)
      ports.dispatch({ input: 'projectsLoaded', categoryId, sort, listing })
  }

  private static async createProject(
    effect: Extract<LauncherEffect, { effect: 'createProject' }>,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.projects
      .create(effect.categoryId, effect.name, effect.virtualFolderPrefix)
    const created = LauncherEffects.listed(answer, (detail) =>
      ports.dispatch({ input: 'loadFailed', detail }))
    if (created)
      ports.dispatch({ input: 'projectCreated', categoryId: effect.categoryId, name: created.name })
  }

  /** A cancelled dialog sends no input: the cursor stays where it was and nothing else changes. */
  private static async pickDirectory(ports: LauncherPorts): Promise<void> {
    const answer = await window.appClient.dialog.pickDirectory('Pick a folder to work in')
    if (!answer.ok)
      return ports.dispatch({ input: 'loadFailed', detail: answer.error })
    if (answer.value !== null)
      ports.dispatch({ input: 'directoryPicked', path: answer.value.path })
  }

  /**
   * Every session both providers recorded for the project selected in New Session. A project whose
   * provider history cannot be read still starts new sessions, so the failure is a line in the form
   * rather than a screen that never arrives.
   */
  private static async readHistory(
    categoryId: string,
    projectName: string,
    projectPath: string,
    report: (input: HistoryRead) => void,
  ): Promise<void> {
    const [answer, local] = await Promise.all([
      window.appClient.projects.sessions(categoryId, projectName),
      window.appClient.sessions.historyReferences({ mode: 'project', categoryId, projectPath }),
    ])
    // The project travels back with every answer. The first read of a project is the slow one - the
    // library reads transcripts to title them - so leaving it and opening another leaves two reads
    // in flight, and the screen guard in the overlay only knows that a create card is up.
    if (!answer.ok)
      return report({
        input: 'existingSessionsFailed',
        categoryId,
        projectName,
        detail: answer.error,
      })
    if (!answer.value.ok)
      return report({
        input: 'existingSessionsFailed',
        categoryId,
        projectName,
        detail: `${answer.value.code}: ${answer.value.detail}`,
      })
    if (!local.ok)
      return report({
        input: 'existingSessionsFailed',
        categoryId,
        projectName,
        detail: local.error,
      })
    if (!local.value.ok)
      return report({
        input: 'existingSessionsFailed',
        categoryId,
        projectName,
        detail: `${local.value.code}: ${local.value.detail}`,
      })
    report({
      input: 'existingSessionsLoaded',
      categoryId,
      projectName,
      summaries: LauncherEffects.joinedHistory(
        answer.value.value.merged,
        local.value.value.references,
      ),
    })
  }

  private static joinedHistory(
    summaries: readonly Omit<ExistingSessionSummary, 'localTitle'>[],
    references: readonly SessionHistoryReference[],
  ): ExistingSessionSummary[] {
    const titles = new Map(references.map((reference) => [
      `${reference.agentId}/${reference.nativeSessionId}`,
      reference.title,
    ]))
    return summaries.map((summary) => ({
      ...summary,
      localTitle: titles.get(`${summary.agentId}/${summary.nativeSessionId}`) ?? null,
    }))
  }

  /**
   * The one create path of this shell, shared by every screen that starts a session. Its refusals are
   * the library's words, handed back to whichever screen asked so they stay where they can be read.
   */
  private static async startSession(
    spec: SessionCreateSpec,
    onFailure: (
      code: string,
      detail: string,
      setup?: SessionSetupAgreement,
    ) => void,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.sessions.create(spec)
    return LauncherEffects.openSessionResult(
      answer,
      spec.presentation === 'tab',
      onFailure,
      ports,
    )
  }

  private static async openHistory(
    spec: SessionHistoryOpenSpec,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.sessions.openHistory(spec)
    return LauncherEffects.openSessionResult(
      answer,
      false,
      (code, detail) => ports.create({ input: 'submitFailed', code, detail }),
      ports,
    )
  }

  /**
   * The one submit that names a session instead of a spec. What a fork IS stays the library's: this
   * sends the id and the name that was typed over the parent's, and the number pair, the agent, the
   * conversation and the directory are all read off the record on the other side.
   */
  private static async forkSession(
    sessionId: string,
    name: string,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.sessions.fork(sessionId, { name })
    return LauncherEffects.openSessionResult(
      answer,
      false,
      (code, detail) => ports.create({ input: 'submitFailed', code, detail }),
      ports,
    )
  }

  /**
   * Bring one session back, which is the tree row's Rerun asked from the card: `reopen` resumes the
   * conversation by id under the SAME record, so nothing is created and nothing is named here.
   *
   * The restart is published before the tab is drawn, for the panel that is already open on this
   * session holding a terminal that has stopped: that is the one thing an open panel cannot work out
   * for itself. A panel opened by the line after it attaches to the live runtime as it mounts.
   */
  private static async resumeSession(
    sessionId: string,
    tabTitle: string,
    ports: LauncherPorts,
  ): Promise<void> {
    const onFailure = (code: string, detail: string, setup?: SessionSetupAgreement): void =>
      ports.create({ input: 'submitFailed', code, detail, setup })
    const answer = await window.appClient.sessions.reopen(sessionId)
    if (!answer.ok) return onFailure('transport', answer.error)
    if (!answer.value.ok)
      return onFailure(answer.value.code, answer.value.detail, answer.value.setup)
    const published = await window.appClient.tabs.publishTerminalRestarted(sessionId)
    if (!published.ok) AppClientUiReport.error(`terminal restart not published: ${published.error}`)
    const failure = await SessionTabOpener.open(
      (id, title, options) => ports.openTerminal({ kind: 'local', sessionId: id }, title, options),
      sessionId,
      tabTitle,
      { plain: false, closePlain: (id) => SessionTabOpener.closePlain(id) },
    )
    if (failure !== null) return onFailure('panel-open', failure)
    ports.markHandedOff()
    ports.close()
  }

  private static async openSessionResult(
    answer: IpcResult<SessionsOpResult<{ sessionId: string; tabTitle: string }>>,
    plain: boolean,
    onFailure: (
      code: string,
      detail: string,
      setup?: SessionSetupAgreement,
    ) => void,
    ports: LauncherPorts,
  ): Promise<void> {
    if (!answer.ok)
      return onFailure('transport', answer.error)
    if (!answer.value.ok)
      return onFailure(answer.value.code, answer.value.detail, answer.value.setup)
    // What KIND of tab is derived from the spec: every screen goes through this one create, so what
    // was asked for decides it and nothing else. What the tab is CALLED comes back with the create,
    // because the place a session runs in is the library's to say and not this screen's.
    const failure = await SessionTabOpener.open(
      (sessionId, title, options) =>
        ports.openTerminal({ kind: 'local', sessionId }, title, options),
      answer.value.value.sessionId,
      answer.value.value.tabTitle,
      {
        plain,
        closePlain: (sessionId) => SessionTabOpener.closePlain(sessionId),
      },
    )
    if (failure !== null) return onFailure('panel-open', failure)
    ports.markHandedOff()
    ports.close()
  }

  /**
   * The codes that mean the far side may or may not have done the thing. Only these keep the
   * operation id: everything else is a decision, and repeating a decided operation with its own id
   * would answer with what was decided rather than with what is now being asked.
   */
  private static readonly uncertainCodesConst: readonly RemoteControlError['code'][] =
    ['unavailable', 'timeout']

  private static remoteFailureOf(
    error: RemoteControlError,
    pending: { operationId: string; spec: SessionCreateSpec } | null,
  ): SubmitFailed {
    const failure: SubmitFailed = { input: 'submitFailed', code: error.code, detail: error.detail }
    if (pending === null || !LauncherEffects.uncertainCodesConst.includes(error.code))
      return failure
    return { ...failure, retryCreate: pending }
  }

  private static createdSessionOf(
    value: RemoteResponseValue,
  ): { sessionId: string; tabTitle: string } | null {
    if (!('session' in value)) return null
    return { sessionId: value.session.sessionId, tabTitle: value.session.tabTitle }
  }

  /**
   * That computer's catalog, in one call: `projects.list` with no category answers with every one of
   * them and its listing, so the screen is seeded whole and the category in front is not asked for
   * a second time.
   */
  private static async fetchRemoteCatalog(
    remoteEndpointId: string,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.remote.listProjects(remoteEndpointId, {})
    const categories = LauncherEffects.remoteCatalogOf(answer, (detail) =>
      ports.dispatch({ input: 'loadFailed', detail }))
    if (categories === null) return
    // The listings first and the categories after: the categories are what makes the screen ask for
    // a listing, and by then it is already held.
    for (const entry of categories)
      LauncherEffects.reportRemoteListing(entry.category.id, 'recent', entry.listing, ports)
    ports.dispatch({
      input: 'categoriesLoaded',
      categories: categories.map((entry) => entry.category),
    })
  }

  private static async fetchRemoteProjects(
    remoteEndpointId: string,
    categoryId: string,
    sort: LauncherSort,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.remote
      .listProjects(remoteEndpointId, { categoryId, sort })
    const categories = LauncherEffects.remoteCatalogOf(answer, (detail) =>
      ports.dispatch({ input: 'projectsLoadFailed', categoryId, sort, detail }))
    if (categories === null) return
    const found = categories.find((entry) => entry.category.id === categoryId)
    if (found === undefined)
      return ports.dispatch({
        input: 'projectsLoadFailed',
        categoryId,
        sort,
        detail: `That computer no longer has a category ${JSON.stringify(categoryId)}.`,
      })
    LauncherEffects.reportRemoteListing(categoryId, sort, found.listing, ports)
  }

  private static reportRemoteListing(
    categoryId: string,
    sort: LauncherSort,
    listing: ProjectsOpResult<ProjectListResult>,
    ports: LauncherPorts,
  ): void {
    if (!listing.ok)
      return ports.dispatch({
        input: 'projectsLoadFailed',
        categoryId,
        sort,
        detail: `${listing.code}: ${listing.detail}`,
      })
    ports.dispatch({ input: 'projectsLoaded', categoryId, sort, listing: listing.value })
  }

  /** Both unwraps plus the shape check, because this value crossed two processes and a network. */
  private static remoteCatalogOf(
    answer: IpcResult<RemoteControlResponse>,
    report: (detail: string) => void,
  ): readonly RemoteControlProjectCategoryDto[] | null {
    if (!answer.ok) {
      report(answer.error)
      return null
    }
    if (!answer.value.ok) {
      report(`${answer.value.error.code}: ${answer.value.error.detail}`)
      return null
    }
    const value = answer.value.value
    if (!('categories' in value)) {
      report('That computer answered the project list with something this one cannot read.')
      return null
    }
    // `SessionsSnapshot` carries a `categories` of its own, so the key alone does not say which
    // answer this is; a listing beside the category is what only the project list has.
    return value.categories
      .filter((entry): entry is RemoteControlProjectCategoryDto => 'listing' in entry)
  }

  /**
   * The target's own sessions in one project, off the snapshot it already pushed. Nothing is asked
   * over the wire: this is the same list its rows in the tree are drawn from.
   */
  private static async readRemoteSessions(
    remoteEndpointId: string,
    projectPath: string,
    ports: LauncherPorts,
  ): Promise<void> {
    const snapshot = await LauncherEffects.readRemoteSnapshot()
    if (snapshot === null)
      return ports.create({
        input: 'remoteSessionsFailed',
        projectPath,
        detail: 'The connected computers could not be read.',
      })
    const endpoint = snapshot.outbound
      .find((candidate) => candidate.remoteEndpointId === remoteEndpointId)
    if (endpoint === undefined || endpoint.status !== 'connected')
      return ports.create({
        input: 'remoteSessionsFailed',
        projectPath,
        detail: 'That computer is no longer connected.',
      })
    ports.create({
      input: 'remoteSessionsLoaded',
      projectPath,
      sessions: LauncherEffects.remoteSessionsIn(endpoint.sessions?.sessions ?? [], projectPath),
    })
  }

  private static remoteSessionsIn(
    sessions: readonly SessionInfo[],
    projectPath: string,
  ): readonly RemoteExistingSession[] {
    return sessions
      .filter((session) => session.project.kind === 'project'
        && session.project.projectPath === projectPath
        // A plain tab is not a session of that computer's tree, and Continue only offers those.
        && session.presentation === undefined)
      .map((session) => ({
        sessionId: session.sessionId,
        tabTitle: session.tabTitle,
        title: session.title,
        agentId: session.agent?.agentId ?? null,
        running: session.life === 'live' || session.life === 'starting',
      }))
  }

  private static async deletePreview(
    categoryId: string,
    name: string,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.projects.deletePreview(categoryId, name)
    const preview = LauncherEffects.operated({ categoryId, name }, answer, ports)
    if (preview)
      ports.manage({ input: 'previewReady', categoryId, name, preview })
  }

  private static async deleteExecute(
    effect: Extract<ManageEffect, { effect: 'deleteExecute' }>,
    ports: LauncherPorts,
  ): Promise<void> {
    const answer = await window.appClient.projects.deleteProject(effect.token)
    const report = LauncherEffects
      .operated({ categoryId: effect.categoryId, name: effect.name }, answer, ports)
    if (report)
      ports.manage({
        input: 'deleted',
        categoryId: effect.categoryId,
        name: effect.name,
        report,
      })
  }

  private static async relocation(
    project: { categoryId: string; name: string },
    call: Promise<IpcResult<ProjectsOpResult<RelocationReport>>>,
    ports: LauncherPorts,
  ): Promise<void> {
    const report = LauncherEffects.operated(project, await call, ports)
    if (report)
      ports.manage({ input: 'relocated', ...project, report })
  }

  /** The caller decides whether a refusal needs request identity before it reaches the screen. */
  private static listed<T>(
    answer: IpcResult<ProjectsOpResult<T>>,
    report: (detail: string) => void,
  ): T | null {
    if (!answer.ok) {
      report(answer.error)
      return null
    }
    if (!answer.value.ok) {
      report(`${answer.value.code}: ${answer.value.detail}`)
      return null
    }
    return answer.value.value
  }

  /**
   * An operation failure is about one project, so it keeps its code and names the project it ran on.
   * The name is what lands it at the right row, or at no row at all: a refusal is as late an answer
   * as a report, and the model drops it rather than drawing it under whatever is under the cursor.
   */
  private static operated<T>(
    project: { categoryId: string; name: string },
    answer: IpcResult<ProjectsOpResult<T>>,
    ports: LauncherPorts,
  ): T | null {
    if (!answer.ok) {
      ports.manage({ input: 'operationFailed', ...project, code: 'transport', detail: answer.error })
      return null
    }
    if (!answer.value.ok) {
      ports.manage({
        input: 'operationFailed',
        ...project,
        code: answer.value.code,
        detail: answer.value.detail,
      })
      return null
    }
    return answer.value.value
  }
}
