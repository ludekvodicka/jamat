import { AwakeClock } from './awakeClock'
import type { ProcessCallMessage, ProcessPowerMessage } from './processWire.types'

export interface ProcessCallContext {
  signal: AbortSignal
  pending(): void
}

interface OutboundCall {
  resolve(value: unknown): void
  reject(error: Error): void
  acceptedAt: number | null
  startedAt: number
  unsubscribe(): void
  invalidate(): void
}

export class ProcessCalls {
  private readonly clock: AwakeClock
  private readonly send: (message: ProcessCallMessage) => void
  private readonly invoke: (target: string, method: string, args: unknown[], context: ProcessCallContext) => Promise<unknown>
  private readonly event: (target: string, name: string, payload: unknown) => void
  private readonly report: (message: string) => void
  private readonly outbound: Map<number, OutboundCall>
  private readonly inbound: Map<number, { controller: AbortController; repliedAt: number | null }>
  private readonly timer: ReturnType<typeof setInterval>
  private nextId: number
  private lastAlive: number
  private closed: boolean

  constructor(deps: {
    send(message: ProcessCallMessage): void
    invoke(target: string, method: string, args: unknown[], context: ProcessCallContext): Promise<unknown>
    event(target: string, name: string, payload: unknown): void
    report(message: string): void
  }) {
    this.clock = new AwakeClock()
    this.send = deps.send
    this.invoke = deps.invoke
    this.event = deps.event
    this.report = deps.report
    this.outbound = new Map()
    this.inbound = new Map()
    this.nextId = 0
    this.lastAlive = this.clock.now()
    this.closed = false
    this.timer = setInterval(() => { setTimeout(() => this.check(), 0).unref?.() }, 1_000)
    this.timer.unref?.()
  }

  call<T>(target: string, method: string, args: unknown[], options?: { signal?: AbortSignal; invalidate?: () => void }): Promise<T> {
    const signal = options?.signal
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Private process connection is closed or cancelled'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const cancel = (): void => this.cancel(id, 'Private process request cancelled')
      this.outbound.set(id, { resolve: value => resolve(value as T), reject, startedAt: this.clock.now(), acceptedAt: null,
        invalidate: options?.invalidate ?? (() => {}),
        unsubscribe: () => signal?.removeEventListener('abort', cancel) })
      signal?.addEventListener('abort', cancel, { once: true })
      try { this.send({ type: 'call', id, target, method, args }) }
      catch (error) { this.close(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  emit(target: string, name: string, payload: unknown): boolean {
    if (this.closed) return false
    try { this.send({ type: 'event', target, name, payload }); return true }
    catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); return false }
  }

  power(message: ProcessPowerMessage): void {
    if (!this.clock.power(message.epoch, message.event).late) return
    const now = this.clock.now()
    this.lastAlive = now
    for (const call of this.outbound.values()) {
      call.startedAt = now
      if (call.acceptedAt !== null) call.acceptedAt = now
    }
    for (const call of this.inbound.values())
      if (call.repliedAt !== null) call.repliedAt = now
  }

  alive(): void { this.lastAlive = this.clock.now() }

  receive(message: ProcessCallMessage): void {
    if (this.closed) return
    switch (message.type) {
      case 'call': {
        if (this.inbound.has(message.id)) throw new Error(`Duplicate private call id ${message.id}`)
        const controller = new AbortController()
        const state = { controller, repliedAt: null as number | null }
        this.inbound.set(message.id, state)
        const pending = (): void => {
          if (!controller.signal.aborted && !this.closed) this.send({ type: 'pending', id: message.id })
        }
        // Start each handler independently: a held input must not block its release or detach.
        let work: Promise<unknown>
        try { work = this.invoke(message.target, message.method, message.args, { signal: controller.signal, pending }) }
        catch (error) { work = Promise.reject(error) }
        void work.then(value => {
            if (!controller.signal.aborted && !this.closed) {
              state.repliedAt = this.clock.now()
              this.send({ type: 'reply', id: message.id, ok: true, value })
            }
          }, error => {
            if (!controller.signal.aborted && !this.closed) {
              state.repliedAt = this.clock.now()
              this.send({ type: 'reply', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          }).catch(error => { this.report(String(error)); this.close() })
        return
      }
      case 'pending': {
        const call = this.outbound.get(message.id)
        if (!call) { this.report(`Unknown private pending id ${message.id}`); return }
        call.acceptedAt = this.clock.now()
        return
      }
      case 'reply': {
        const call = this.outbound.get(message.id)
        if (!call) {
          this.report(`Unknown private reply id ${message.id}`)
          this.send({ type: 'cancel', id: message.id })
          return
        }
        try { this.send({ type: 'received', id: message.id }) }
        catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); return }
        this.outbound.delete(message.id)
        call.unsubscribe()
        if (message.ok) call.resolve(message.value)
        else if (!message.ok) call.reject(new Error(message.error))
        else throw new Error(`Unknown private reply status: ${JSON.stringify(message)}`)
        return
      }
      case 'cancel': {
        this.inbound.get(message.id)?.controller.abort()
        this.inbound.delete(message.id)
        return
      }
      case 'received': this.inbound.delete(message.id); return
      case 'event': this.event(message.target, message.name, message.payload); return
      default: throw new Error(`Unknown private message: ${(message as { type: string }).type}`)
    }
  }

  close(error = new Error('Private process connection closed')): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    for (const call of this.outbound.values()) { call.invalidate(); call.unsubscribe(); call.reject(error) }
    this.outbound.clear()
    for (const { controller } of this.inbound.values()) controller.abort()
    this.inbound.clear()
  }

  private check(): void {
    if (this.closed) return
    this.clock.tick()
    const now = this.clock.now()
    for (const [id, call] of this.outbound) {
      const aliveAt = call.acceptedAt === null ? call.startedAt : Math.max(call.acceptedAt, this.lastAlive)
      if (now - aliveAt >= 30_000) this.cancel(id, 'Private process request lost liveness for 30 seconds')
    }
    for (const [id, call] of this.inbound)
      if (call.repliedAt !== null && now - call.repliedAt >= 30_000) {
        call.controller.abort()
        this.inbound.delete(id)
      }
  }

  private cancel(id: number, detail: string): void {
    const call = this.outbound.get(id)
    if (!call) return
    this.outbound.delete(id)
    call.invalidate()
    call.unsubscribe()
    try { this.send({ type: 'cancel', id }) }
    catch (error) { this.report(String(error)); this.close() }
    call.reject(new Error(detail))
  }
}
