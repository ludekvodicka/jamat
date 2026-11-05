export interface ViewerReservation<T> { send(value: T): Promise<void>; release(): void }
interface CreditWaiter<T> {
  bytes: number
  signal: AbortSignal
  abort: () => void
  resolve: (slot: ViewerReservation<T>) => void
  reject: (error: Error) => void
}

export class ViewerBuffer<T> {
  static readonly bytesMaxConst = 2 * 1024 * 1024
  private readonly send: (value: T, generation: number, sequence: number) => void
  private readonly bytesOf: (value: T, generation: number, sequence: number) => number
  private readonly truncate: (generation: number) => void
  private readonly resume: () => void
  private readonly pending: Map<number, { generation: number; bytes: number; settle?: (failed: boolean) => void }>
  private readonly waiting: CreditWaiter<T>[]
  private readonly reservations: Set<() => void>
  private bytes: number
  private generation: number
  private sequence: number
  private truncated: boolean
  private closed: boolean

  constructor(deps: { send: ViewerBuffer<T>['send']; bytesOf: ViewerBuffer<T>['bytesOf']; truncate: ViewerBuffer<T>['truncate']; resume: () => void }) {
    this.send = deps.send
    this.bytesOf = deps.bytesOf
    this.truncate = deps.truncate
    this.resume = deps.resume
    this.pending = new Map()
    this.waiting = []
    this.reservations = new Set()
    this.bytes = 0
    this.generation = 1
    this.sequence = 0
    this.truncated = false
    this.closed = false
  }

  push(value: T): boolean {
    if (this.closed || this.truncated) return false
    const bytes = this.bytesOf(value, this.generation, this.sequence + 1)
    if (this.bytes + bytes > ViewerBuffer.bytesMaxConst) {
      this.truncated = true
      this.cancelReservations()
      this.truncate(++this.generation)
      return false
    }
    const sequence = ++this.sequence
    this.bytes += bytes
    this.pending.set(sequence, { generation: this.generation, bytes })
    try { this.send(value, this.generation, sequence) }
    catch (error) { this.close(); throw error }
    return true
  }

  exceedsLimit(value: T): boolean { return this.bytesOf(value, this.generation, this.sequence + 1) > ViewerBuffer.bytesMaxConst }

  reserve(bytes: number, signal: AbortSignal): Promise<ViewerReservation<T>> {
    if (this.closed || this.truncated || signal.aborted)
      return Promise.reject(new Error('Viewer snapshot reservation cancelled'))
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > ViewerBuffer.bytesMaxConst)
      return Promise.reject(new Error('Snapshot frame reservation exceeds the viewer limit'))
    return new Promise((resolve, reject) => {
      const waiter: CreditWaiter<T> = { bytes, signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter)
        if (index !== -1) this.waiting.splice(index, 1)
        reject(new Error('Viewer snapshot reservation cancelled'))
        this.drain()
      } }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiting.push(waiter)
      this.drain()
    })
  }

  received(generation: number, sequence: number, failed = false): void {
    const pending = this.pending.get(sequence)
    if (!pending || pending.generation !== generation) return
    this.bytes -= pending.bytes
    this.pending.delete(sequence)
    pending.settle?.(failed)
    this.drain()
  }

  resetReceived(generation: number): void {
    // A reset cannot refill Electron's native queue until every earlier frame was consumed.
    if (this.closed || !this.truncated || generation !== this.generation || this.bytes !== 0) return
    this.truncated = false
    this.resume()
  }

  close(): void {
    this.closed = true
    this.cancelReservations()
    for (const pending of this.pending.values()) pending.settle?.(true)
    this.pending.clear()
    this.bytes = 0
  }

  private drain(): void {
    if (this.closed || this.truncated) return
    while (this.waiting.length) {
      const waiter = this.waiting[0]!
      if (this.bytes + waiter.bytes > ViewerBuffer.bytesMaxConst) return
      this.waiting.shift()
      waiter.signal.removeEventListener('abort', waiter.abort)
      this.bytes += waiter.bytes
      let reserved = true
      let settled = false
      let fail: (() => void) | null = null
      const release = (): void => {
        if (reserved) {
          reserved = false
          this.bytes -= waiter.bytes
          this.reservations.delete(release)
          waiter.signal.removeEventListener('abort', release)
          this.drain()
        }
        // Native in-flight bytes retire only with their real receipt, even after the owner cancels.
        else fail?.()
      }
      waiter.signal.addEventListener('abort', release, { once: true })
      this.reservations.add(release)
      waiter.resolve({ release, send: value => {
        if (!reserved || waiter.signal.aborted || this.closed || this.truncated)
          return Promise.reject(new Error('Viewer snapshot reservation is no longer valid'))
        const bytes = this.bytesOf(value, this.generation, this.sequence + 1)
        if (bytes > waiter.bytes) { release(); return Promise.reject(new Error('Snapshot frame exceeds its reservation')) }
        reserved = false
        this.reservations.delete(release)
        this.bytes += bytes - waiter.bytes
        const sequence = ++this.sequence
        return new Promise<void>((resolve, reject) => {
          fail = () => { if (!settled) { settled = true; reject(new Error('Snapshot consumer cancelled or failed')) } }
          this.pending.set(sequence, { bytes, generation: this.generation, settle: failed => {
            waiter.signal.removeEventListener('abort', release)
            if (failed) fail?.()
            else if (!settled) { settled = true; resolve() }
          } })
          try { this.send(value, this.generation, sequence) }
          catch (error) { this.close(); reject(error) }
          this.drain()
        })
      } })
    }
  }

  private cancelReservations(): void {
    for (const waiter of this.waiting.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(new Error('Viewer snapshot reservation cancelled'))
    }
    for (const release of this.reservations) release()
  }
}
