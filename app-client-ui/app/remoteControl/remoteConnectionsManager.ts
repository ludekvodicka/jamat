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
  connect(profile: RemoteControlPeerProfile, signal: AbortSignal): Promise<RemoteControlStepResult<RemoteControlPeerTransport>>
  onChanged(): void
  onError(message: string): void
  requestId?(): string
  operationId?(): string
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
  attachPromise: Promise<RemoteControlStepResult<{ attachId: string; sessionId: string }>> | null
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
  selectedSessionIds: Set<string>
  abort: AbortController | null
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
  static readonly idleDelayMillisecondsConst = 0
  private readonly byEndpoint = new Map<string, RemoteOutboundState>()
  private readonly holders = new Map<string, string>()
  private readonly requestId: () => string
  private readonly operationId: () => string
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

  async connectComputer(holderId: string, remoteEndpointId: string): Promise<RemoteControlStepResult<undefined>> {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state) return RemoteConnectionsManager.error('not-found', 'Remote endpoint is unknown')
    const previous = this.holders.get(holderId)
    this.holders.set(holderId, remoteEndpointId)
    if (previous && previous !== remoteEndpointId) {
      const old = this.byEndpoint.get(previous)
      if (old) this.unwanted(old)
    }
    if (!await this.ensureConnected(state))
      return { ok: false, error: state.error ?? { code: 'unavailable', detail: 'Remote computer is offline. Press Connect to try again.' } }
    return { ok: true, value: undefined }
  }

  releaseConnections(holderId: string): void {
    const endpointId = this.holders.get(holderId)
    this.holders.delete(holderId)
    const state = endpointId === undefined ? undefined : this.byEndpoint.get(endpointId)
    if (state) this.unwanted(state)
  }

  async selectSession(remoteEndpointId: string, sessionId: string): Promise<RemoteControlStepResult<undefined>> {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state || state.status !== 'connected')
      return RemoteConnectionsManager.error('unavailable', 'Connect the computer first')
    if (!state.sessions?.sessions.some((session) => session.sessionId === sessionId))
      await this.refreshSessions(state, state.generation)
    if (state.status !== 'connected' || !state.sessions?.sessions.some((session) => session.sessionId === sessionId))
      return RemoteConnectionsManager.error('not-found', 'Remote session is no longer available')
    state.selectedSessionIds.add(sessionId)
    this.cancelIdle(state)
    this.changed()
    return { ok: true, value: undefined }
  }

  isSessionSelected(remoteEndpointId: string, sessionId: string): boolean {
    return this.byEndpoint.get(remoteEndpointId)?.selectedSessionIds.has(sessionId) ?? false
  }

  async disconnectSessions(remoteEndpointId: string, sessionIds?: readonly string[]): Promise<void> {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state) return
    const removed = new Set(sessionIds ?? state.selectedSessionIds)
    for (const id of removed) state.selectedSessionIds.delete(id)
    if (sessionIds === undefined)
      for (const [holder, endpointId] of this.holders)
        if (endpointId === remoteEndpointId) this.holders.delete(holder)
    this.changed()
    const attachments = [...state.attachments.values()].filter((attachment) =>
      sessionIds === undefined || removed.has(attachment.spec.sessionId))
    await Promise.all(attachments.map(async (attachment) => {
      RemoteConnectionsManager.safeFrame(attachment, {
        type: 'terminal.status', status: 'lost', detail: 'Disconnected locally. The remote session continues running.',
      })
      await this.detachTerminal(remoteEndpointId, attachment.attachId)
    }))
    this.unwanted(state)
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
      }
    }
  }

  private needed(state: RemoteOutboundState): boolean {
    return [...this.holders.values()].includes(state.profile.remoteEndpointId)
      || state.selectedSessionIds.size > 0 || state.attachments.size > 0 || state.pending > 0
  }

  private unwanted(state: RemoteOutboundState): void {
    if (this.needed(state) || state.idleTimer) return
    const generation = state.generation
    state.idleTimer = this.setTimer(() => {
      state.idleTimer = null
      if (!this.current(state, generation)
        || this.needed(state))
        return
      state.generation += 1
      state.abort?.abort()
      state.connectPromise = null
      state.refreshPromise = null
      state.refreshOwed = false
      this.disposeConnection(state)
      state.status = 'idle'
      state.error = null
      // Hung up, so what it last said about its sessions is history rather than an answer.
      state.sessions = null
      this.changed()
    }, this.idleDelay)
    state.idleTimer.unref?.()
  }

  private cancelIdle(state: RemoteOutboundState): void {
    if (!state.idleTimer) return
    this.clearTimer(state.idleTimer)
    state.idleTimer = null
  }

  retryNow(remoteEndpointId: string): void {
    const state = this.byEndpoint.get(remoteEndpointId)
    if (!state) return
    void this.ensureConnected(state).finally(() => this.unwanted(state))
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
      attachPromise: null,
      active: false,
    }
    state.attachments.set(attachId, attachment)
    this.cancelIdle(state)
    if (state.status !== 'connected' || !state.channel) {
      RemoteConnectionsManager.safeFrame(attachment, {
        type: 'terminal.status', status: 'connecting',
        detail: 'Remote computer is disconnected. Open Remote computers and press Connect.',
      })
      return RemoteConnectionsManager.error('unavailable', 'Connect the remote computer first')
    }
    if (state.sessions?.reconciled !== true) {
      RemoteConnectionsManager.safeFrame(attachment, {
        type: 'terminal.status', status: 'connecting', detail: 'Waiting for remote sessions to synchronize.',
      })
      return RemoteConnectionsManager.error('unavailable', 'Waiting for remote sessions to synchronize.')
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
      return RemoteConnectionsManager.error('unavailable', 'Remote terminal is disconnected. Press Connect to reconnect.')
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

  private connect(state: RemoteOutboundState): Promise<void> {
    if (state.connectPromise) return state.connectPromise
    if (!this.started || this.stopping || state.status === 'connecting' || state.status === 'connected')
      return Promise.resolve()
    const promise = this.dial(state)
    state.connectPromise = promise
    return promise.finally(() => {
      if (state.connectPromise === promise) state.connectPromise = null
    })
  }

  private async ensureConnected(state: RemoteOutboundState): Promise<boolean> {
    if (RemoteConnectionsManager.isConnected(state)) return true
    this.cancelIdle(state)
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
    const abort = new AbortController()
    state.abort = abort
    const answer = await this.deps.connect(state.profile, abort.signal).catch(() =>
      RemoteConnectionsManager.error<RemoteControlPeerTransport>('unavailable', 'Remote connection failed'))
    if (!this.current(state, generation)) {
      if (answer.ok) answer.value.close()
      return
    }
    if (!answer.ok) {
      state.status = 'offline'
      state.error = structuredClone(answer.error)
      this.changed()
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
        || (message.frame.type === 'terminal.status' && message.frame.status === 'lost')) {
        attachment.attached = false
        attachment.attachPromise = null
      }
      RemoteConnectionsManager.safeFrame(attachment, message.frame)
    })
    const ready = await this.synchronize(state, generation)
    if (!ready || !this.current(state, generation)) {
      answer.value.close()
      return
    }
    state.status = 'connected'
    state.error = null
    state.lastConnectedAt = this.now()
    this.changed()
    void this.hello(state, generation)
    this.reattachAvailable(state)
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
    if (!this.current(state, generation) || state.channel !== channel || !response.ok) return
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
    const promise = this.refreshSessionsNow(state, generation)
    state.refreshPromise = promise
    try { return await promise }
    finally {
      if (state.refreshPromise === promise) {
        state.refreshPromise = null
        if (state.refreshOwed && this.current(state, generation)) {
          state.refreshOwed = false
          void this.refreshSessions(state, generation)
        }
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
    if (!this.current(state, generation) || state.channel !== channel) return false
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
    this.reattachAvailable(state)
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

  private reattachAvailable(state: RemoteOutboundState): void {
    // Persisted live rows can arrive before the restarted peer has resolved their Host runtimes.
    if (state.status !== 'connected' || state.sessions?.reconciled !== true) return
    for (const attachment of state.attachments.values())
      if (!attachment.attached && state.sessions?.sessions.some((session) =>
        session.sessionId === attachment.spec.sessionId && session.life === 'live'))
        void this.attach(state, attachment)
  }

  private attach(
    state: RemoteOutboundState,
    attachment: ManagedRemoteAttachment,
  ): Promise<RemoteControlStepResult<{ attachId: string; sessionId: string }>> {
    if (attachment.attached)
      return Promise.resolve({ ok: true, value: { attachId: attachment.attachId, sessionId: attachment.spec.sessionId } })
    if (attachment.attachPromise) return attachment.attachPromise
    const promise = this.attachNow(state, attachment)
    attachment.attachPromise = promise
    return promise.finally(() => {
      if (attachment.attachPromise === promise) attachment.attachPromise = null
    })
  }

  private async attachNow(
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
    if (state.channel !== channel || state.attachments.get(attachment.attachId) !== attachment) {
      // A disconnect can remove the local attachment before the peer finishes opening it.
      if (response.ok && state.channel === channel)
        await channel.socket({
          protocol: RemoteControlConst.protocol,
          requestId: this.requestId(),
          operationId: this.operationId(),
          operation: 'terminal.detach',
          attachId: attachment.attachId,
        })
      return RemoteConnectionsManager.error('unavailable', 'Remote terminal attach was removed')
    }
    const result = RemoteConnectionsManager.socketStep(response)
    attachment.attached = result.ok
    // Transport failures retain the attachment for a later explicit connection attempt.
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
      return RemoteConnectionsManager.error('unavailable', 'Remote terminal is disconnected. Press Connect to reconnect.')
    return RemoteConnectionsManager.socketStep(await state.channel.socket(request))
  }

  private disconnected(state: RemoteOutboundState, generation: number): void {
    if (!this.current(state, generation) || state.status === 'offline') return
    const needed = this.needed(state)
    state.generation += 1
    state.connectPromise = null
    state.refreshPromise = null
    state.refreshOwed = false
    state.channel = null
    state.connectionId = null
    state.status = needed ? 'offline' : 'idle'
    state.error = needed
      ? { code: 'unavailable', detail: 'Remote AppClientUI disconnected. Press Connect to reconnect.' }
      : null
    for (const attachment of state.attachments.values()) {
      attachment.attached = false
      attachment.attachPromise = null
      RemoteConnectionsManager.safeFrame(attachment, {
        type: 'terminal.status',
        status: 'connecting',
        detail: 'Remote AppClientUI disconnected. Press Connect to reconnect.',
      })
    }
    this.changed()
  }

  private disposeState(state: RemoteOutboundState): void {
    state.generation += 1
    this.cancelIdle(state)
    state.abort?.abort()
    state.connectPromise = null
    state.selectedSessionIds.clear()
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
      selectedSessionIds: new Set(),
      abort: null,
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
      selectedSessionIds: [...state.selectedSessionIds],
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
