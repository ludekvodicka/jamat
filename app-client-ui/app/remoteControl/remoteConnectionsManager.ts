import { randomUUID } from 'node:crypto'

import type {
  RemoteControlError,
  RemoteControlEventDto,
  RemoteControlOptionalOperation,
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlSocketRequest,
  RemoteControlSocketResponse,
  RemoteControlStepResult,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type {
  RemoteConnectionsPort,
  RemoteConnectionsSnapshot,
  RemoteControlPeerTransport,
  RemoteOutboundEndpointDto,
} from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerBackoff } from '../../../lib-orchestrator/remoteControl/remoteControlPeerBackoff'
import { RemoteControlPeerChannel } from '../../../lib-orchestrator/remoteControl/remoteControlPeerChannel'
import type {
  SessionsOpResult,
  SessionsSnapshot,
  TerminalAttachSpec,
  TerminalFrame,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionReference } from '../../../lib-orchestrator/sessionManager/sessionReference'
import { SessionsSnapshotValidation } from '../../../lib-orchestrator/sessionManager/sessionsSnapshotValidation'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

export interface RemoteConnectionsManagerDeps {
  identity: RemoteControlPeerIdentity
  profiles(): readonly RemoteControlPeerProfile[]
  connect(profile: RemoteControlPeerProfile): Promise<RemoteControlStepResult<RemoteControlPeerTransport>>
  onChanged(): void
  onError(message: string): void
  requestId?(): string
  operationId?(): string
  reconnectDelay?(attempt: number): number
  /** The clock the two timestamps in the snapshot are read off, so a test can hold one still. */
  now?(): number
  /** How long a connection outlives its last holder. Named by a test rather than waited out. */
  idleDelayMilliseconds?: number
  setTimer?(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

interface ManagedRemoteAttachment {
  attachId: string
  spec: TerminalAttachSpec
  onFrame(frame: TerminalFrame): void
  attached: boolean
  active: boolean
}

interface RemoteOutboundState {
  profile: RemoteControlPeerProfile
  generation: number
  status: RemoteOutboundEndpointDto['status']
  error: RemoteControlError | null
  channel: RemoteControlPeerChannel | null
  connectionId: string | null
  sessions: SessionsSnapshot | null
  lastConnectedAt: number | null
  nextRetryAt: number | null
  applicationVersion: string | null
  optionalOperations: readonly RemoteControlOptionalOperation[] | null
  reconnectAttempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** Set while a dial is in flight, so a second caller waits for it instead of starting another. */
  connectPromise: Promise<void> | null
  /** Counts commands in flight through this endpoint; one of them is a reason to stay connected. */
  pending: number
  /** Armed when the last reason to be connected goes, and what finally hangs up. */
  idleTimer: ReturnType<typeof setTimeout> | null
  attachments: Map<string, ManagedRemoteAttachment>
  refreshPromise: Promise<boolean> | null
  refreshOwed: boolean
}

export class RemoteConnectionsManager implements RemoteConnectionsPort {
  /**
   * How long a connection outlives its last holder. Long enough that closing a remote tab and
   * opening another does not cost a handshake, short enough that a window left on the sessions
   * tree is not holding a socket open on the other machine for the rest of the day.
   */
  static readonly idleDelayMillisecondsConst = 30_000
  private readonly byEndpoint = new Map<string, RemoteOutboundState>()
  /**
   * Who is asking for every paired computer to be reachable: a launcher card picking a computer,
   * the Network settings screen. Held by name so the same surface asking twice is one hold, and
   * so a window that dies without releasing can be cleaned up by the id it was given.
   */
  private readonly holders = new Set<string>()
  private readonly requestId: () => string
  private readonly operationId: () => string
  private readonly reconnectDelay: (attempt: number) => number
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number
  private readonly idleDelay: number
  private revision = 0
  private started = false
  private stopping = false

  constructor(private readonly deps: RemoteConnectionsManagerDeps) {
    this.requestId = deps.requestId ?? randomUUID
    this.operationId = deps.operationId ?? randomUUID
    this.reconnectDelay = deps.reconnectDelay ?? RemoteControlPeerBackoff.delay
    this.setTimer = deps.setTimer ?? setTimeout
    this.clearTimer = deps.clearTimer ?? clearTimeout
    this.now = deps.now ?? Date.now
    this.idleDelay = deps.idleDelayMilliseconds
      ?? RemoteConnectionsManager.idleDelayMillisecondsConst
  }

  /**
   * Nothing is dialled here, and that is the whole design: a paired computer is reached when
   * something needs it and hung up on when nothing does. Starting used to dial every profile at
   * once, so a machine sat connected to every computer it had ever been paired with, drawn as a
   * live row in the sessions tree, for as long as the app was open.
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopping = false
    this.reloadProfiles()
  }

  /**
   * "Keep every paired computer reachable while I am open." The launcher's computer list and the
   * Network settings screen each take one: both draw what only a live connection can answer, and
   * both are closed again in seconds.
   *
   * A hold is not a connection. It says a dial may happen and should be retried while it fails;
   * what a caller waits for is the status in the snapshot.
   */
  holdConnections(holderId: string): void {
    if (this.holders.has(holderId)) return
    this.holders.add(holderId)
    for (const state of this.byEndpoint.values()) this.wanted(state)
  }

  releaseConnections(holderId: string): void {
    if (!this.holders.delete(holderId)) return
    for (const state of this.byEndpoint.values()) this.unwanted(state)
  }

  reloadProfiles(): void {
    const profiles = this.deps.profiles().map((profile) => structuredClone(profile))
    const currentIds = new Set(profiles.map((profile) => profile.remoteEndpointId))
    for (const [endpointId, state] of this.byEndpoint)
      if (!currentIds.has(endpointId)) {
        this.disposeState(state)
        this.byEndpoint.delete(endpointId)
        this.changed()
      }
    for (const profile of profiles) {
      const state = this.byEndpoint.get(profile.remoteEndpointId)
      if (!state) {
        const created = RemoteConnectionsManager.state(profile)
        this.byEndpoint.set(profile.remoteEndpointId, created)
        this.changed()
        if (this.started) this.wanted(created)
      } else if (JSON.stringify(state.profile) !== JSON.stringify(profile)) {
        this.disposeState(state)
        state.profile = profile
        state.generation += 1
        state.status = 'idle'
        state.error = null
        state.sessions = null
        // Everything the connection said belongs to the address it said it at. A moved endpoint is
        // another computer until one answers there, so its version is not carried across the edit.
        state.lastConnectedAt = null
        state.applicationVersion = null
        state.optionalOperations = null
        this.changed()
        if (this.started) this.wanted(state)
      }
    }
  }

  /** Whether anything is asking for this computer right now: a screen, a tab, a command. */
  private static needed(state: RemoteOutboundState, holders: ReadonlySet<string>): boolean {
    return holders.size > 0 || state.attachments.size > 0 || state.pending > 0
  }

  /** Something started needing it: cancel the hang-up, and dial if nothing is connected. */
  private wanted(state: RemoteOutboundState): void {
    if (!this.started
      || this.stopping
      || !RemoteConnectionsManager.needed(state, this.holders))
      return
    this.cancelIdle(state)
    if (state.status === 'connected' || state.status === 'connecting') return
    void this.connect(state)
  }

  /**
   * Something stopped needing it. The hang-up waits out `idleDelay` rather than happening here,
   * because closing one remote tab to open another would otherwise cost a full handshake, and
   * because the first thing a person does after closing the settings card is open it again.
   */
  private unwanted(state: RemoteOutboundState): void {
    if (RemoteConnectionsManager.needed(state, this.holders) || state.idleTimer) return
    const generation = state.generation
    state.idleTimer = this.setTimer(() => {
      state.idleTimer = null
      if (!this.current(state, generation)
        || RemoteConnectionsManager.needed(state, this.holders))
        return
      this.cancelReconnect(state)
      this.disposeConnection(state)
      state.status = 'idle'
      state.error = null
      // Hung up, so what it last said about its sessions is history rather than an answer.
      state.sessions = null
      state.reconnectAttempt = 0
      this.changed()
    }, this.idleDelay)
    state.idleTimer.unref?.()
  }

  private cancelIdle(state: RemoteOutboundState): void {
    if (!state.idleTimer) return
    this.clearTimer(state.idleTimer)
    state.idleTimer = null
  }

  /**
   * Now, instead of when the backoff says. The person at the screen knows what the timer cannot -
   * the far end was just started, the firewall rule was just written - so the wait goes and the
   * count with it: a dial that fails again starts the backoff over at its shortest delay rather
   * than at the hour this one had climbed to.
   *
   * A profile that is already connected or already dialling is answered by doing nothing, which is
   * `connect`'s own rule and not a second one written here. The pending hang-up is called off too:
   * the button is on a screen that is holding this computer anyway, and a Retry that dialled into a
   * timer about to fire would be a connection that hangs up a moment after it stands.
   */
  retryNow(remoteEndpointId: string): void {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state) return
    void this.ensureConnected(state)
  }

  stop(): void {
    if (this.stopping) return
    this.stopping = true
    this.holders.clear()
    for (const state of this.byEndpoint.values()) this.disposeState(state)
    if (this.byEndpoint.size > 0) this.changed()
  }

  snapshot(): RemoteConnectionsSnapshot {
    return {
      revision: this.revision,
      outbound: [...this.byEndpoint.values()]
        .map((state) => RemoteConnectionsManager.dto(state))
        .sort((first, second) => first.profileId.localeCompare(second.profileId)),
      inbound: [],
    }
  }

  /**
   * One session of a paired computer, written down for a SECOND agent. It asks that computer
   * nothing: its sessions already arrive whole on every refresh, so the block is composed here from
   * what is held, by the same composer the local menu uses. The transcript line is absent by nature,
   * because that file sits on the other machine's disk.
   */
  sessionReference(
    remoteEndpointId: string,
    sessionId: string,
  ): SessionsOpResult<{ text: string }> {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state)
      return { ok: false, code: 'not-found', detail: 'That computer is not paired any more' }
    const info = state.sessions?.sessions.find((session) => session.sessionId === sessionId)
    if (info === undefined)
      return {
        ok: false,
        code: 'not-found',
        detail: `Session ${sessionId} is not in what ${state.profile.displayName} last sent`,
      }
    return {
      ok: true,
      value: {
        text: SessionReference.text(
          SessionReference.factsOf(info, state.profile.displayName, null, {
            kind: 'remote',
            controllerConfigIdentity: this.deps.identity.configIdentity,
            controllerChannel: this.deps.identity.runtimeChannel,
            remoteEndpointId,
            targetConfigIdentity: state.profile.configIdentity,
            targetChannel: state.profile.runtimeChannel,
          }),
        ),
      },
    }
  }

  /**
   * A command for a paired computer, which dials it if nothing has. The CLI and the skill address a
   * computer by name and know nothing about connections, so refusing an idle one with `unavailable`
   * would have made every command depend on a window being open somewhere.
   *
   * The wait is the dial, the handshake and the first session read. It is paid by the first command
   * after a quiet spell and by no other, because the endpoint stays up while the count is above
   * zero and for the idle delay after it drops.
   */
  async execute(
    remoteEndpointId: string,
    request: RemoteControlRequestUnion,
  ): Promise<RemoteControlResponse> {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state)
      return RemoteConnectionsManager.controlFailure(request, 'not-found', 'Remote endpoint is unknown')
    state.pending += 1
    try {
      if (!await this.ensureConnected(state) || !state.channel)
        return RemoteConnectionsManager.controlFailure(
          request,
          'unavailable',
          'Remote AppClientUI is offline',
        )
      return await state.channel.control(request)
    } finally {
      state.pending -= 1
      this.unwanted(state)
    }
  }

  async attachTerminal(
    remoteEndpointId: string,
    attachId: string,
    spec: TerminalAttachSpec,
    onFrame: (frame: TerminalFrame) => void,
  ): Promise<RemoteControlStepResult<{ attachId: string; sessionId: string }>> {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state)
      return RemoteConnectionsManager.error('not-found', 'Remote endpoint is unknown')
    if (state.attachments.has(attachId))
      return RemoteConnectionsManager.error(
        'conflict',
        `Terminal attach ${JSON.stringify(attachId)} already exists`,
      )
    const attachment: ManagedRemoteAttachment = {
      attachId,
      spec: structuredClone(spec),
      onFrame,
      attached: false,
      active: false,
    }
    // In the map before the dial, so it is already a reason to be connected and the reconnect
    // loop keeps it: an attach is the one holder that outlives the call that made it.
    state.attachments.set(attachId, attachment)
    this.cancelIdle(state)
    if (state.status !== 'connected') {
      RemoteConnectionsManager.safeFrame(attachment, {
        type: 'terminal.status',
        status: 'connecting',
        detail: 'Reaching the remote computer',
      })
      if (!await this.ensureConnected(state) || !state.channel) {
        // Left in the map on purpose when the endpoint is still wanted: the frame above says
        // connecting, and the reconnect loop is what turns that into a terminal.
        if (state.attachments.get(attachId) !== attachment)
          return RemoteConnectionsManager.error('unavailable', 'Remote terminal attach was removed')
        return RemoteConnectionsManager.error('unavailable', 'Remote AppClientUI is offline')
      }
      if (state.attachments.get(attachId) !== attachment)
        return RemoteConnectionsManager.error('unavailable', 'Remote terminal attach was removed')
    }
    return this.attach(state, attachment)
  }

  terminalInput(
    remoteEndpointId: string,
    attachId: string,
    data: string,
  ): Promise<RemoteControlStepResult<unknown>> {
    return this.terminalMutation(remoteEndpointId, attachId, {
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operationId: this.operationId(),
      operation: 'terminal.input',
      attachId,
      data,
    })
  }

  terminalResize(
    remoteEndpointId: string,
    attachId: string,
    cols: number,
    rows: number,
  ): Promise<RemoteControlStepResult<unknown>> {
    return this.terminalMutation(remoteEndpointId, attachId, {
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operationId: this.operationId(),
      operation: 'terminal.resize',
      attachId,
      cols,
      rows,
    })
  }

  async terminalActive(
    remoteEndpointId: string,
    attachId: string,
    active: boolean,
  ): Promise<RemoteControlStepResult<unknown>> {
    const state = this.byEndpoint.get(remoteEndpointId)
    const attachment = state?.attachments.get(attachId)
    if (!state || !attachment)
      return RemoteConnectionsManager.error('not-found', 'Remote terminal attach is unknown')
    attachment.active = active
    if (!state.channel || state.status !== 'connected' || !attachment.attached)
      return RemoteConnectionsManager.error('unavailable', 'Remote terminal attach is reconnecting')
    return RemoteConnectionsManager.socketStep(await state.channel.socket({
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operationId: this.operationId(),
      operation: 'terminal.active',
      attachId,
      active,
    }))
  }

  async detachTerminal(
    remoteEndpointId: string,
    attachId: string,
  ): Promise<RemoteControlStepResult<unknown>> {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state)
      return RemoteConnectionsManager.error('not-found', 'Remote endpoint is unknown')
    const attachment = state.attachments.get(attachId)
    if (!attachment)
      return RemoteConnectionsManager.error('not-found', 'Remote terminal attach is unknown')
    state.attachments.delete(attachId)
    // The last tab closing is what starts the hang-up, and it starts it here rather than where the
    // window went: a detach is the same event whether a person closed the tab or the window died.
    this.unwanted(state)
    if (!attachment.attached || !state.channel)
      return { ok: true, value: { attachId } }
    return RemoteConnectionsManager.socketStep(await state.channel.socket({
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operationId: this.operationId(),
      operation: 'terminal.detach',
      attachId,
    }))
  }

  /**
   * One dial per endpoint at a time, and every caller waits for the same one. Two surfaces opening
   * at once is the ordinary case - a launcher card over a settings screen - and two dials to one
   * computer would leave one of the two transports orphaned.
   */
  private connect(state: RemoteOutboundState): Promise<void> {
    if (state.connectPromise) return state.connectPromise
    if (this.stopping || state.status === 'connecting' || state.status === 'connected')
      return Promise.resolve()
    state.connectPromise = this.dial(state)
    return state.connectPromise.finally(() => { state.connectPromise = null })
  }

  /**
   * Dial now, whatever the backoff had planned. What asks for this knows what a timer cannot: a
   * person just opened a card about this computer, or a command was just sent to it.
   */
  private async ensureConnected(state: RemoteOutboundState): Promise<boolean> {
    if (RemoteConnectionsManager.isConnected(state)) return true
    this.cancelIdle(state)
    this.cancelReconnect(state)
    state.reconnectAttempt = 0
    await this.connect(state)
    return RemoteConnectionsManager.isConnected(state)
  }

  /** Read through a call rather than in place: the status either side of an await is not one fact. */
  private static isConnected(state: RemoteOutboundState): boolean {
    return state.status === 'connected'
  }

  private async dial(state: RemoteOutboundState): Promise<void> {
    const generation = state.generation
    state.status = 'connecting'
    state.error = null
    state.nextRetryAt = null
    this.changed()
    const answer = await this.deps.connect(state.profile)
    if (!this.current(state, generation)) {
      if (answer.ok) answer.value.close()
      return
    }
    if (!answer.ok) {
      state.status = 'offline'
      state.error = structuredClone(answer.error)
      this.changed()
      this.scheduleReconnect(state)
      return
    }
    state.connectionId = answer.value.connectionId
    state.channel = new RemoteControlPeerChannel(answer.value, {
      onError: (message) => this.deps.onError(message),
    })
    answer.value.onClose(() => this.disconnected(state, generation))
    state.channel.onEvent((message) => this.event(state, generation, message.event))
    state.channel.onTerminalFrame((message) => {
      const attachment = state.attachments.get(message.attachId)
      if (!attachment) return
      if (message.frame.type === 'terminal.exit'
        || (message.frame.type === 'terminal.status' && message.frame.status === 'lost'))
        attachment.attached = false
      RemoteConnectionsManager.safeFrame(attachment, message.frame)
    })
    const ready = await this.synchronize(state, generation)
    if (!ready || !this.current(state, generation)) {
      answer.value.close()
      return
    }
    state.status = 'connected'
    state.error = null
    state.reconnectAttempt = 0
    state.lastConnectedAt = this.now()
    this.changed()
    void this.hello(state, generation)
    for (const attachment of state.attachments.values()) {
      if (!this.current(state, generation)) return
      void this.attach(state, attachment)
    }
  }

  /**
   * The one question asked of a paired computer that is not about its sessions: what it runs, and
   * what it offers beyond the operations every controller may call. Asked once per connection,
   * after that connection stands, and never on the way there - a refusal or a timeout costs the two
   * readings and nothing else, because a version nobody could read is no reason to hang up.
   */
  private async hello(state: RemoteOutboundState, generation: number): Promise<void> {
    const channel = state.channel
    if (!channel) return
    const response = await channel.control({
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operation: 'system.hello',
      body: {},
    })
    if (!this.current(state, generation) || !response.ok) return
    const hello = RemoteConnectionsManager.helloOf(response.value)
    if (!hello) return
    state.applicationVersion = hello.applicationVersion
    state.optionalOperations = hello.optionalOperations
    this.changed()
  }

  private async synchronize(state: RemoteOutboundState, generation: number): Promise<boolean> {
    const channel = state.channel
    if (!channel) return false
    const subscribed = await channel.socket({
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operation: 'events.subscribe',
    })
    if (!subscribed.ok) {
      state.error = structuredClone(subscribed.error)
      return false
    }
    const subscription = RemoteConnectionsManager.subscription(subscribed.value)
    if (!subscription) {
      state.error = { code: 'operation-failed', detail: 'Remote event subscription is invalid' }
      return false
    }
    return this.refreshSessions(state, generation)
  }

  private async refreshSessions(
    state: RemoteOutboundState,
    generation: number,
  ): Promise<boolean> {
    if (state.refreshPromise) {
      state.refreshOwed = true
      return state.refreshPromise
    }
    state.refreshPromise = this.refreshSessionsNow(state, generation)
    try { return await state.refreshPromise }
    finally {
      state.refreshPromise = null
      if (state.refreshOwed && this.current(state, generation)) {
        state.refreshOwed = false
        void this.refreshSessions(state, generation)
      }
    }
  }

  private async refreshSessionsNow(
    state: RemoteOutboundState,
    generation: number,
  ): Promise<boolean> {
    const channel = state.channel
    if (!channel) return false
    const response = await channel.control({
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operation: 'sessions.list',
      body: {},
    })
    if (!this.current(state, generation)) return false
    if (!response.ok) {
      state.error = structuredClone(response.error)
      return false
    }
    const snapshot = SessionsSnapshotValidation.parse(response.value)
    if (!snapshot) {
      state.error = { code: 'operation-failed', detail: 'Remote sessions snapshot is invalid' }
      return false
    }
    state.sessions = snapshot
    this.changed()
    return true
  }

  private event(
    state: RemoteOutboundState,
    generation: number,
    event: RemoteControlEventDto,
  ): void {
    if (!this.current(state, generation)) return
    if (event.kind === 'sessions.changed') void this.refreshSessions(state, generation)
    else if (event.kind === 'tabs.changed') return
    else
      throw new Error(`Unknown remote event kind: ${JSON.stringify(event)}`)
  }

  private async attach(
    state: RemoteOutboundState,
    attachment: ManagedRemoteAttachment,
  ): Promise<RemoteControlStepResult<{ attachId: string; sessionId: string }>> {
    const channel = state.channel
    if (!channel)
      return RemoteConnectionsManager.error('unavailable', 'Remote AppClientUI is offline')
    const response = await channel.socket({
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operationId: this.operationId(),
      operation: 'terminal.attach',
      attachId: attachment.attachId,
      sessionId: attachment.spec.sessionId,
      size: structuredClone(attachment.spec.size),
    })
    if (state.attachments.get(attachment.attachId) !== attachment)
      return RemoteConnectionsManager.error('unavailable', 'Remote terminal attach was removed')
    const result = RemoteConnectionsManager.socketStep(response)
    attachment.attached = result.ok
    /*
     * A refusal is the remote's own answer - no such session, not live - and it is final. Keeping
     * the attachment after one poisons its attachId for every retry (`already exists`) and hands
     * each reconnect a dead attachment to open again for as long as the profile lives. A transport
     * failure is the other case: it says nothing about the session, so that one waits for the next
     * connection, which is what the reconnect loop is for.
     */
    if (!result.ok) {
      if (result.error.code !== 'unavailable' && result.error.code !== 'timeout')
        state.attachments.delete(attachment.attachId)
      return result
    }
    if (attachment.active)
      await this.terminalActive(state.profile.remoteEndpointId, attachment.attachId, true)
    return result as RemoteControlStepResult<{ attachId: string; sessionId: string }>
  }

  private async terminalMutation(
    remoteEndpointId: string,
    attachId: string,
    request: Exclude<RemoteControlSocketRequest, { operation: 'events.subscribe' | 'terminal.attach' | 'terminal.detach' }>,
  ): Promise<RemoteControlStepResult<unknown>> {
    const state = this.byEndpoint.get(remoteEndpointId)
    const attachment = state?.attachments.get(attachId)
    if (!state || !attachment)
      return RemoteConnectionsManager.error('not-found', 'Remote terminal attach is unknown')
    if (!state.channel || state.status !== 'connected' || !attachment.attached)
      return RemoteConnectionsManager.error('unavailable', 'Remote terminal attach is reconnecting')
    return RemoteConnectionsManager.socketStep(await state.channel.socket(request))
  }

  private disconnected(state: RemoteOutboundState, generation: number): void {
    if (!this.current(state, generation) || state.status === 'offline') return
    const needed = RemoteConnectionsManager.needed(state, this.holders)
    state.channel = null
    state.connectionId = null
    state.status = needed ? 'offline' : 'idle'
    state.error = needed
      ? { code: 'unavailable', detail: 'Remote AppClientUI disconnected' }
      : null
    for (const attachment of state.attachments.values()) {
      attachment.attached = false
      RemoteConnectionsManager.safeFrame(attachment, {
        type: 'terminal.status',
        status: 'connecting',
        detail: 'Remote AppClientUI disconnected',
      })
    }
    this.changed()
    if (needed) this.scheduleReconnect(state)
  }

  /** Only while something is still asking. Nobody retries a computer nobody wants to reach. */
  private scheduleReconnect(state: RemoteOutboundState): void {
    if (this.stopping
      || state.reconnectTimer
      || !RemoteConnectionsManager.needed(state, this.holders))
      return
    const generation = state.generation
    const delay = this.reconnectDelay(state.reconnectAttempt++)
    // Written where the wait is decided rather than where it is drawn: a screen adding the delay to
    // its own clock would say a different minute on every computer whose clock has drifted.
    state.nextRetryAt = this.now() + delay
    state.reconnectTimer = this.setTimer(() => {
      state.reconnectTimer = null
      if (this.current(state, generation)) void this.connect(state)
    }, delay)
    state.reconnectTimer.unref?.()
  }

  private cancelReconnect(state: RemoteOutboundState): void {
    if (state.reconnectTimer) {
      this.clearTimer(state.reconnectTimer)
      state.reconnectTimer = null
    }
    state.nextRetryAt = null
  }

  private disposeState(state: RemoteOutboundState): void {
    state.generation += 1
    this.cancelIdle(state)
    this.cancelReconnect(state)
    this.disposeConnection(state)
    for (const attachment of state.attachments.values())
      RemoteConnectionsManager.safeFrame(attachment, {
        type: 'terminal.status',
        status: 'lost',
        detail: 'Remote endpoint was removed',
        code: 'unknown-session',
      })
    state.attachments.clear()
  }

  private disposeConnection(state: RemoteOutboundState): void {
    const channel = state.channel
    state.channel = null
    state.connectionId = null
    for (const attachment of state.attachments.values()) attachment.attached = false
    channel?.close()
  }

  private current(state: RemoteOutboundState, generation: number): boolean {
    return !this.stopping
      && state.generation === generation
      && this.byEndpoint.get(state.profile.remoteEndpointId) === state
  }

  private changed(): void {
    this.revision += 1
    this.deps.onChanged()
  }

  private static state(profile: RemoteControlPeerProfile): RemoteOutboundState {
    return {
      profile,
      generation: 0,
      status: 'idle',
      error: null,
      channel: null,
      connectionId: null,
      sessions: null,
      lastConnectedAt: null,
      nextRetryAt: null,
      applicationVersion: null,
      optionalOperations: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      connectPromise: null,
      pending: 0,
      idleTimer: null,
      attachments: new Map(),
      refreshPromise: null,
      refreshOwed: false,
    }
  }

  private static dto(state: RemoteOutboundState): RemoteOutboundEndpointDto {
    return {
      profileId: state.profile.profileId,
      remoteComputerId: state.profile.remoteComputerId,
      remoteEndpointId: state.profile.remoteEndpointId,
      configIdentity: state.profile.configIdentity,
      runtimeChannel: state.profile.runtimeChannel,
      displayName: state.profile.displayName,
      endpoint: structuredClone(state.profile.endpoint),
      status: state.status,
      error: structuredClone(state.error),
      lastConnectedAt: state.lastConnectedAt,
      nextRetryAt: state.nextRetryAt,
      applicationVersion: state.applicationVersion,
      optionalOperations: state.optionalOperations === null
        ? null
        : [...state.optionalOperations],
      connectionId: state.connectionId,
      sessions: structuredClone(state.sessions),
    }
  }

  /**
   * The two readings this side keeps out of a hello, taken by hand because the answer comes from
   * another computer and is under no obligation to be the shape the type says.
   *
   * An operation name this build does not know is DROPPED rather than refused: the far end may be a
   * newer one offering something this gate has never heard of, and losing the version beside it
   * would be the wrong answer to that.
   */
  private static helloOf(value: unknown): {
    applicationVersion: string
    optionalOperations: readonly RemoteControlOptionalOperation[]
  } | null {
    if (!JsonShape.isRecord(value) || typeof value.applicationVersion !== 'string') return null
    const offered = value.optionalOperations
    if (offered !== undefined && !Array.isArray(offered)) return null
    return {
      applicationVersion: value.applicationVersion,
      optionalOperations: (offered ?? []).filter(
        (entry: unknown): entry is RemoteControlOptionalOperation =>
          RemoteControlConst.optionalOperations.some((known) => known === entry),
      ),
    }
  }

  private static subscription(value: unknown): {
    throughRevision: number
    truncated: boolean
  } | null {
    if (!JsonShape.isRecord(value)
      || !Number.isSafeInteger(value.throughRevision)
      || (value.throughRevision as number) < 0
      || typeof value.truncated !== 'boolean')
      return null
    return { throughRevision: value.throughRevision as number, truncated: value.truncated }
  }

  private static socketStep(
    response: Extract<RemoteControlSocketResponse, { type: 'response' }>,
  ): RemoteControlStepResult<unknown> {
    return response.ok
      ? { ok: true, value: response.value }
      : { ok: false, error: structuredClone(response.error) }
  }

  private static controlFailure(
    request: RemoteControlRequestUnion,
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlResponse {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: false,
      error: { code, detail },
    }
  }

  private static error<T>(
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlStepResult<T> {
    return { ok: false, error: { code, detail } }
  }

  private static safeFrame(attachment: ManagedRemoteAttachment, frame: TerminalFrame): void {
    try { attachment.onFrame(frame) } catch {}
  }

}
