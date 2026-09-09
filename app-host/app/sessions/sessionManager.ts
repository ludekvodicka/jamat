import type {
  RuntimeCreateReq,
  RuntimeInspectResult,
  RuntimeMutationAck,
  RuntimeMutationDiagnostic,
  RuntimeRef,
  RuntimeReplaceReq,
  RuntimeSessionInfo,
  TerminalProjectionSnapshot,
} from '../wire/hostWire.js'
import { EventHub } from '../events/eventHub.js'
import type {
  TerminalInstanceDriver,
  TerminalInstanceEvent,
  TerminalInstanceFactory,
} from '../terminal/terminal.types.js'
import { TerminalInstanceManager } from '../terminal/terminalInstanceManager.js'
import { TerminalLaunchError } from '../terminal/terminalLaunchError.js'
import type { TerminalProjectionDelta } from '../terminal/terminalProjection.js'
import { SessionError } from './sessionError.js'
import { SessionRequestValidation } from './sessionRequestValidation.js'
import { SessionStore } from './sessionStore.js'

/**
 * The lifecycle authority. It owns the terminal collection, the generation counter, the create and
 * replace replay records, and the single mutation queue every state change passes through.
 */
export class SessionManager {
  /**
   * How many runtimes one Host will hold at once.
   *
   * It is a guard against a client that has lost count, not a statement about what a machine can
   * carry: a PTY costs a process and a screen buffer, and the Host itself keeps only a record per
   * runtime. Raised from 32 on 2026-09-05, where it stopped being a guard and became the ceiling of
   * ordinary use - 32 real agent sessions were live, several of them days old, and the next create
   * had nowhere to go.
   */
  private static readonly maxLiveConst = 64
  private readonly terminals: TerminalInstanceManager
  private readonly terminalSubscribers = new Set<(event: TerminalInstanceEvent) => void>()
  private readonly stopReasons = new Map<string, RuntimeSessionInfo['exitReason']>()
  private readonly lastGeneration = new Map<string, number>()
  private mutationQueue: Promise<void> = Promise.resolve()
  private acceptingMutations = true

  constructor(
    private readonly store: SessionStore,
    private readonly events: EventHub,
    private readonly hostInstanceId: string,
    terminalFactory?: TerminalInstanceFactory,
  ) {
    this.terminals = new TerminalInstanceManager(
      (event) => this.onTerminalEvent(event),
      terminalFactory,
    )
  }

  async create(
    request: RuntimeCreateReq,
    beforeMutation?: () => void,
  ): Promise<RuntimeSessionInfo> {
    return this.serializeMutation(() => {
      this.requireAcceptingMutations()
      beforeMutation?.()
      return this.createOwned(request)
    })
  }

  private async createOwned(request: RuntimeCreateReq): Promise<RuntimeSessionInfo> {
    SessionRequestValidation.validateOperationId(request.operationId)
    SessionRequestValidation.validateRuntimeId(request.runtimeSessionId)
    SessionRequestValidation.validateLaunch(request.launch)
    const requestKey = SessionRequestValidation.requestKey(request, ['controllerLeaseId'])
    const replay = this.operation(request.operationId, 'create', requestKey)
    if (replay)
      return this.replay(replay.target)
    if (this.liveCount() >= SessionManager.maxLiveConst)
      throw new SessionError(
        'limit-exceeded',
        `${SessionManager.maxLiveConst} live runtimes is the limit`,
      )
    if (this.store.get(request.runtimeSessionId))
      throw new SessionError('conflict', `Runtime already exists: ${request.runtimeSessionId}`)
    const generation = this.nextGeneration(request.runtimeSessionId)
    const startedAt = Date.now()
    const terminal = await this.startTerminal(
      request.runtimeSessionId,
      () => this.terminals.create(request.runtimeSessionId, generation, 1, request.launch),
    )
    const session = terminal.info(startedAt)
    this.store.upsert(session, false)
    this.store.recordOperation(request.operationId, {
      kind: 'create',
      requestKey,
      target: this.ref(session),
    })
    this.events.publish({ kind: 'runtime-created', session })
    return session
  }

  async replace(
    request: RuntimeReplaceReq,
    beforeMutation?: () => void,
  ): Promise<RuntimeSessionInfo> {
    return this.serializeMutation(() => {
      this.requireAcceptingMutations()
      beforeMutation?.()
      return this.replaceOwned(request)
    })
  }

  private async replaceOwned(request: RuntimeReplaceReq): Promise<RuntimeSessionInfo> {
    SessionRequestValidation.validateOperationId(request.operationId)
    this.validateTarget(request.target)
    SessionRequestValidation.validateLaunch(request.launch)
    const requestKey = SessionRequestValidation.requestKey(request, ['controllerLeaseId'])
    const replay = this.operation(request.operationId, 'replace', requestKey)
    if (replay)
      return this.replay(replay.target)
    const previous = this.requireExact(request.target)
    const existing = this.terminals.get(request.target.runtimeSessionId)
    if (existing?.alive) {
      this.stopReasons.set(request.target.runtimeSessionId, 'stopped')
      try { await existing.stop() }
      catch (error) {
        this.stopReasons.delete(request.target.runtimeSessionId)
        throw error
      }
      if (existing.alive) {
        // The reason STAYS. This is the ending nobody could confirm in time, not one nobody asked
        // for, and a process that dies a second after the budget ran out is exactly the case: the
        // exit that follows has to be able to say it was stopped. See `stopOwned`.
        throw new SessionError(
          'conflict',
          `Runtime ${request.target.runtimeSessionId} did not confirm its death, so it cannot be replaced`,
        )
      }
    }
    const generation = this.nextGeneration(request.target.runtimeSessionId)
    const terminal = await this.startTerminal(
      request.target.runtimeSessionId,
      () => this.terminals.replace(
        request.target.runtimeSessionId,
        generation,
        previous.outputEpoch + 1,
        request.launch,
      ),
    )
    const session = terminal.info(Date.now())
    this.stopReasons.delete(request.target.runtimeSessionId)
    this.store.upsert(session, false)
    this.store.recordOperation(request.operationId, {
      kind: 'replace',
      requestKey,
      target: this.ref(session),
    })
    this.events.publish({ kind: 'runtime-replaced', session })
    return session
  }

  list(): RuntimeSessionInfo[] {
    return this.store.list()
      .map((stored) => {
        const terminal = this.terminals.get(stored.runtimeSessionId)
        return terminal?.alive && terminal.generation === stored.generation
          ? terminal.info(stored.startedAt)
          : stored
      })
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  get(runtimeSessionId: string): RuntimeSessionInfo | undefined {
    const stored = this.store.get(runtimeSessionId)
    if (!stored)
      return undefined
    const terminal = this.terminals.get(runtimeSessionId)
    return terminal?.alive && terminal.generation === stored.generation
      ? terminal.info(stored.startedAt)
      : stored
  }

  session(target: RuntimeRef): RuntimeSessionInfo {
    return this.requireExact(target)
  }

  async inspect(target: RuntimeRef): Promise<RuntimeInspectResult> {
    const session = this.requireExact(target)
    const terminal = this.terminals.get(target.runtimeSessionId)
    return {
      session,
      projection: terminal?.generation === target.generation
        ? await terminal.projection.snapshot(terminal.alive)
        : null,
    }
  }

  async stop(
    target: RuntimeRef,
    beforeMutation?: () => void,
  ): Promise<RuntimeMutationAck> {
    return this.serializeMutation(() => {
      this.requireAcceptingMutations()
      beforeMutation?.()
      return this.stopOwned(target)
    })
  }

  private async stopOwned(target: RuntimeRef): Promise<RuntimeMutationAck> {
    this.validateTarget(target)
    const current = this.currentForMutation(target)
    if (!current)
      return this.ack(target, 'already-removed')
    if (current.generation > target.generation)
      return this.ack(target, 'superseded')
    if (current.generation < target.generation)
      return this.ack(target, 'already-removed')
    if (!current.alive)
      return this.ack(target, 'already-dead')
    const terminal = this.terminals.get(target.runtimeSessionId)
    if (!terminal
      || terminal.generation !== target.generation
      || !terminal.alive)
      throw new SessionError(
        'conflict',
        `Runtime ${target.runtimeSessionId} cannot confirm its live process identity`,
      )
    this.stopReasons.set(target.runtimeSessionId, 'stopped')
    try { await terminal.stop() }
    catch (error) {
      this.stopReasons.delete(target.runtimeSessionId)
      throw error
    }
    const stopped = this.get(target.runtimeSessionId)
    if (!stopped
      || stopped.generation !== target.generation
      || stopped.alive) {
      /*
       * The reason STAYS, and dropping it here was a measured fault. An agent that runs its own
       * shutdown can outlive the whole ladder and die a second after it: on 2026-08-19 a stop was
       * asked for at 14:53:23.625 and the process exited at 14:53:24.974, and because this line had
       * already removed the reason, that exit was recorded as `process-exit`. Both witnesses of a
       * wanted ending were lost at once - this one here, and the client's own, which it never wrote
       * because the refusal came back first - so the row read as a session that had crashed.
       *
       * What is refused is the ACK, which is the honest answer: nothing here confirmed the death.
       * What is kept is who asked, which the exit still needs whenever it arrives.
       */
      throw new SessionError(
        'conflict',
        `Runtime ${target.runtimeSessionId} did not confirm its death`,
      )
    }
    return this.ack(target, 'stopped')
  }

  remove(
    target: RuntimeRef,
    beforeMutation?: () => void,
  ): Promise<RuntimeMutationAck> {
    return this.serializeMutation(() => {
      this.requireAcceptingMutations()
      beforeMutation?.()
      return this.removeOwned(target)
    })
  }

  private removeOwned(target: RuntimeRef): RuntimeMutationAck {
    this.validateTarget(target)
    const current = this.currentForMutation(target)
    if (!current)
      return this.ack(target, 'already-removed')
    if (current.generation > target.generation)
      return this.ack(target, 'superseded')
    if (current.generation < target.generation)
      return this.ack(target, 'already-removed')
    if (current.alive)
      throw new SessionError('conflict', `Runtime is alive: ${target.runtimeSessionId}`)
    this.terminals.remove(target.runtimeSessionId)
    this.store.remove(target.runtimeSessionId)
    this.events.publish({ kind: 'runtime-removed', runtimeSessionId: target.runtimeSessionId })
    return this.ack(target, 'removed')
  }

  get instanceId(): string {
    return this.hostInstanceId
  }

  /**
   * Host-wide stop takes its place in the same queue, so work ahead of it finishes and everything
   * behind it is rejected: no request can create a PTY in the gap before process shutdown.
   */
  async stopAll(beforeMutation?: () => void): Promise<void> {
    return this.serializeMutation(async () => {
      beforeMutation?.()
      this.acceptingMutations = false
      try { await this.stopAllOwned() }
      catch (error) {
        this.acceptingMutations = true
        throw error
      }
    })
  }

  private async stopAllOwned(): Promise<void> {
    for (const session of this.list().filter((value) => value.alive))
      this.stopReasons.set(session.runtimeSessionId, 'stopped')
    await this.terminals.stopAll()
  }

  liveCount(): number {
    return this.list().filter((session) => session.alive).length
  }

  counts(): { live: number; dead: number } {
    const sessions = this.list()
    return {
      live: sessions.filter((session) => session.alive).length,
      dead: sessions.filter((session) => !session.alive).length,
    }
  }

  subscribeTerminal(callback: (event: TerminalInstanceEvent) => void): () => void {
    this.terminalSubscribers.add(callback)
    return () => this.terminalSubscribers.delete(callback)
  }

  terminalWrite(target: RuntimeRef, data: string): void {
    this.requireExact(target)
    const terminal = this.terminals.get(target.runtimeSessionId)
    if (!terminal?.alive || terminal.generation !== target.generation)
      throw new SessionError('not-found', `No live runtime: ${target.runtimeSessionId}`)
    terminal.write(data)
  }

  // The new size is stored by onTerminalEvent, which the resize itself raises. Storing it here too
  // wrote the whole diagnostics document twice for one keystroke-speed operation.
  terminalResize(target: RuntimeRef, cols: number, rows: number): void {
    this.requireExact(target)
    const terminal = this.terminals.get(target.runtimeSessionId)
    if (!terminal?.alive || terminal.generation !== target.generation)
      throw new SessionError('not-found', `No live runtime: ${target.runtimeSessionId}`)
    terminal.resize(cols, rows)
  }

  terminalDelta(
    target: RuntimeRef,
    outputEpoch: number,
    sinceSeq: number,
  ): TerminalProjectionDelta {
    this.requireExact(target)
    const terminal = this.terminals.get(target.runtimeSessionId)
    if (!terminal || terminal.generation !== target.generation)
      throw new SessionError('not-found', `No terminal projection: ${target.runtimeSessionId}`)
    return terminal.projection.deltaSince(outputEpoch, sinceSeq)
  }

  async terminalSnapshot(target: RuntimeRef): Promise<TerminalProjectionSnapshot> {
    this.requireExact(target)
    const terminal = this.terminals.get(target.runtimeSessionId)
    if (!terminal || terminal.generation !== target.generation)
      throw new SessionError('not-found', `No terminal projection: ${target.runtimeSessionId}`)
    return terminal.projection.snapshot(terminal.alive)
  }

  destroy(): void {
    this.terminals.dispose()
    this.terminalSubscribers.clear()
  }

  /**
   * Spawn the child and wait for it to be real, converting a launch failure into the wire vocabulary.
   *
   * Only a TerminalLaunchError is converted. Anything else escaping from here is a defect in this
   * Host rather than a bad request, and must keep reading as one instead of being blamed on the
   * caller's launch spec.
   */
  private async startTerminal(
    runtimeSessionId: string,
    start: () => TerminalInstanceDriver,
  ): Promise<TerminalInstanceDriver> {
    let terminal: TerminalInstanceDriver
    try { terminal = start() }
    catch (error) { throw SessionManager.launchFailure(error) }
    try { await terminal.ready() }
    catch (error) {
      this.terminals.remove(runtimeSessionId)
      throw SessionManager.launchFailure(error)
    }
    return terminal
  }

  private static launchFailure(error: unknown): unknown {
    return error instanceof TerminalLaunchError
      ? new SessionError('invalid-request', error.message)
      : error
  }

  /** A recorded result is replayed only while it is still the current ref; otherwise it conflicts. */
  private replay(target: RuntimeRef): RuntimeSessionInfo {
    const current = this.get(target.runtimeSessionId)
    if (!current || current.generation !== target.generation)
      throw new SessionError(
        'conflict',
        `Operation result ${target.runtimeSessionId}:${target.generation} is no longer current`,
      )
    return current
  }

  private operation(
    operationId: string,
    kind: 'create' | 'replace',
    requestKey: string,
  ): ReturnType<SessionStore['operation']> {
    try { return this.store.operation(operationId, kind, requestKey) }
    catch (error) {
      throw new SessionError(
        'conflict',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private currentForMutation(target: RuntimeRef): RuntimeSessionInfo | undefined {
    const lastGeneration = this.lastGeneration.get(target.runtimeSessionId)
    if (lastGeneration === undefined || target.generation > lastGeneration)
      throw new SessionError(
        'conflict',
        `Runtime generation ${target.generation} was not issued by this Host`,
      )
    return this.get(target.runtimeSessionId)
  }

  // Both continuations are the same function, so a rejected predecessor still lets the queue advance.
  private serializeMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private requireAcceptingMutations(): void {
    if (!this.acceptingMutations)
      throw new SessionError('conflict', 'Host is stopping and rejects new mutations')
  }

  private requireExact(target: RuntimeRef): RuntimeSessionInfo {
    this.validateTarget(target)
    const session = this.get(target.runtimeSessionId)
    if (!session)
      throw new SessionError('not-found', `Unknown runtime: ${target.runtimeSessionId}`)
    if (session.generation !== target.generation)
      throw new SessionError(
        'conflict',
        `Expected generation ${target.generation}, found ${session.generation}`,
      )
    return session
  }

  private validateTarget(target: RuntimeRef): void {
    if (!target || typeof target !== 'object' || Array.isArray(target))
      throw new SessionError('invalid-request', 'target is required')
    if (typeof target.hostInstanceId !== 'string' || !target.hostInstanceId)
      throw new SessionError('invalid-request', 'target.hostInstanceId is required')
    if (typeof target.runtimeSessionId !== 'string')
      throw new SessionError('invalid-request', 'target.runtimeSessionId is required')
    SessionRequestValidation.validateRuntimeId(target.runtimeSessionId)
    if (!Number.isInteger(target.generation) || target.generation < 1)
      throw new SessionError(
        'invalid-request',
        'target.generation must be a positive integer',
      )
    if (target.hostInstanceId !== this.hostInstanceId)
      throw new SessionError(
        'conflict',
        `Expected Host instance ${target.hostInstanceId}, this is ${this.hostInstanceId}`,
      )
  }

  /** Monotonic per runtime id for this Host instance, and never reset by remove. */
  private nextGeneration(runtimeSessionId: string): number {
    const generation = (this.lastGeneration.get(runtimeSessionId) ?? 0) + 1
    this.lastGeneration.set(runtimeSessionId, generation)
    return generation
  }

  private ref(session: RuntimeSessionInfo): RuntimeRef {
    return {
      hostInstanceId: this.hostInstanceId,
      runtimeSessionId: session.runtimeSessionId,
      generation: session.generation,
    }
  }

  private ack(
    target: RuntimeRef,
    diagnostic: RuntimeMutationDiagnostic,
  ): RuntimeMutationAck {
    return {
      servedByHostInstanceId: this.hostInstanceId,
      target: { ...target },
      diagnostic,
    }
  }

  private onTerminalEvent(event: TerminalInstanceEvent): void {
    if (event.type === 'exit') {
      const stored = this.store.get(event.runtimeSessionId)
      if (stored && stored.generation === event.generation) {
        const terminal = this.terminals.get(event.runtimeSessionId)
        const current = terminal?.generation === stored.generation
          ? terminal.info(stored.startedAt)
          : stored
        const session: RuntimeSessionInfo = {
          ...current,
          alive: false,
          exitedAt: Date.now(),
          exitCode: event.exitCode,
          exitReason: this.stopReasons.get(event.runtimeSessionId) ?? 'process-exit',
        }
        delete session.pid
        delete session.processStartedAt
        this.stopReasons.delete(event.runtimeSessionId)
        this.store.upsert(session)
        this.events.publish({ kind: 'runtime-exited', session })
      }
    } else if (event.type === 'data') {
      const stored = this.store.get(event.runtimeSessionId)
      if (stored && stored.generation === event.generation)
        this.store.upsert({
          ...stored,
          outputSeq: event.outputSeq,
          outputEpoch: event.outputEpoch,
          lastOutputAt: event.lastOutputAt,
        }, false)
    } else if (event.type === 'resize') {
      const stored = this.store.get(event.runtimeSessionId)
      if (stored && stored.generation === event.generation)
        this.store.upsert({ ...stored, cols: event.cols, rows: event.rows })
    } else
      throw new Error(`Unknown terminal event: ${JSON.stringify(event)}`)

    for (const subscriber of this.terminalSubscribers)
      try { subscriber(event) } catch {}
  }
}
