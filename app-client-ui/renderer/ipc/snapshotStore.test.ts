import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult } from '../../shared/appClientUiIpc'
import { type SnapshotStorePorts, SnapshotStore } from './snapshotStore'

describe('app-client-ui/renderer/ipc/snapshotStore', () => {
  /** Only the revision is the store's business; what else a document carries it never looks at. */
  interface Document {
    revision: number
    holding: string
  }

  type Answer = IpcResult<Document>

  class Ports implements SnapshotStorePorts<Document> {
    reads = 0
    subscriptions = 0
    readonly errors: string[] = []
    private readonly listeners = new Set<() => void>()
    private readonly waiting: ((answer: Answer) => void)[] = []

    constructor(
      private readonly answer: Answer | null = null,
      /** The main process going away mid-call: `ipcRenderer.invoke` rejects, with no answer at all. */
      private readonly refusal: Error | null = null,
    ) {}

    read(): Promise<Answer> {
      this.reads += 1
      if (this.refusal !== null)
        return Promise.reject(this.refusal)
      if (this.answer !== null)
        return Promise.resolve(this.answer)
      return new Promise<Answer>((resolve) => this.waiting.push(resolve))
    }

    subscribe(onChanged: () => void): () => void {
      this.subscriptions += 1
      this.listeners.add(onChanged)
      return () => {
        this.listeners.delete(onChanged)
      }
    }

    reportError(message: string): void {
      this.errors.push(message)
    }

    push(times = 1): void {
      for (let count = 0; count < times; count += 1)
        for (const listener of this.listeners)
          listener()
    }

    settle(answer: Answer): void {
      const resolve = this.waiting.shift()
      if (!resolve)
        throw new Error('No read is in flight')
      resolve(answer)
    }

    get activeSubscriptions(): number {
      return this.listeners.size
    }
  }

  function documentOf(revision: number): Document {
    return { revision, holding: 'whatever the subsystem answers with' }
  }

  function storeOf(ports: Ports): SnapshotStore<Document> {
    return new SnapshotStore<Document>('The sessions snapshot', ports)
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('owns one reader and publishes one document to every subscriber', async () => {
    const ports = new Ports()
    const store = storeOf(ports)
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    store.subscribe(second)
    const stop = store.start()

    expect(ports.reads).toBe(1)
    expect(ports.subscriptions).toBe(1)
    expect(ports.activeSubscriptions).toBe(1)
    expect(() => store.start()).toThrow('already started')

    const snapshot = documentOf(1)
    ports.settle({ ok: true, value: snapshot })
    await vi.advanceTimersByTimeAsync(0)

    expect(store.current().snapshot).toBe(snapshot)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    stop()
    expect(ports.activeSubscriptions).toBe(0)
  })

  /**
   * The rule a poll makes load-bearing: the rate monitor reads every ten minutes and most reads change
   * nothing, so a snapshot whose revision has not moved must keep its identity and wake nobody.
   */
  it('turns one push burst into one read and wakes nobody for an unmoved revision', async () => {
    const ports = new Ports()
    const store = storeOf(ports)
    const woken = vi.fn()
    store.subscribe(woken)
    store.start()
    const snapshot = documentOf(1)
    ports.settle({ ok: true, value: snapshot })
    await vi.advanceTimersByTimeAsync(0)
    expect(woken).toHaveBeenCalledTimes(1)

    ports.push(5)
    await vi.advanceTimersByTimeAsync(100)
    expect(ports.reads).toBe(2)

    ports.settle({ ok: true, value: documentOf(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.current().snapshot).toBe(snapshot)
    expect(woken).toHaveBeenCalledTimes(1)

    ports.push()
    await vi.advanceTimersByTimeAsync(100)
    ports.settle({ ok: true, value: documentOf(2) })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.current().snapshot?.revision).toBe(2)
    expect(woken).toHaveBeenCalledTimes(2)
  })

  it('shares one give-up state, named after the document, and one Retry', async () => {
    const ports = new Ports({ ok: false, error: 'the main process is gone' })
    const store = storeOf(ports)
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    store.subscribe(second)
    store.start()

    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [200, 400, 800, 1600])
      await vi.advanceTimersByTimeAsync(delay)

    expect(ports.reads).toBe(5)
    expect(store.current().error).toContain('The sessions snapshot could not be read')
    expect(store.current().error).toContain('stopped refreshing')
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()

    ports.push()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(ports.reads).toBe(5)

    store.refresh()
    expect(store.current().error).toBe(null)
    expect(ports.reads).toBe(6)
  })

  /*
   * The same give-up, reached the other way. An `ok: false` is an ANSWER; a rejection is the read
   * never coming back, and only the reader's `.catch` puts it back down. Without it the store draws
   * its last document for ever, says nothing, and its Retry cannot help - which is the state a user
   * would report as "it froze".
   */
  it('reaches the same give-up when the read rejects rather than answers', async () => {
    const ports = new Ports(null, new Error('the main process is gone'))
    const store = storeOf(ports)
    const woken = vi.fn()
    store.subscribe(woken)
    store.start()

    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [200, 400, 800, 1600])
      await vi.advanceTimersByTimeAsync(delay)

    expect(ports.reads).toBe(5)
    expect(store.current().error).toContain('the main process is gone')
    expect(store.current().error).toContain('stopped refreshing')
    expect(woken).toHaveBeenCalled()
  })

  it('drops its IPC subscription and armed timer when stopped', async () => {
    const ports = new Ports()
    const store = storeOf(ports)
    const stop = store.start()
    ports.settle({ ok: true, value: documentOf(1) })
    await vi.advanceTimersByTimeAsync(0)
    ports.push()

    stop()
    await vi.advanceTimersByTimeAsync(100)

    expect(ports.activeSubscriptions).toBe(0)
    expect(ports.reads).toBe(1)
  })
})
