import type { RemoteControlStepResult } from './remoteControlApi.types'

interface RemoteControlOperationEntry<T> {
  fingerprint: string
  promise: Promise<T>
  settled: boolean
}

export type RemoteControlOperationStoreResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'conflict' }
  | { kind: 'full' }

export class RemoteControlOperationStore {
  private readonly entries = new Map<string, RemoteControlOperationEntry<unknown>>()

  constructor(private readonly limit = 512) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error(`Invalid operation store limit: ${JSON.stringify(limit)}`)
  }

  async run<T>(
    callerId: string,
    operationId: string,
    fingerprint: string,
    work: () => Promise<T>,
  ): Promise<RemoteControlOperationStoreResult<T>> {
    const key = `${callerId}\0${operationId}`
    const held = this.entries.get(key)
    if (held) {
      if (held.fingerprint !== fingerprint) return { kind: 'conflict' }
      return { kind: 'value', value: await held.promise as T }
    }
    if (!this.makeRoom()) return { kind: 'full' }

    const entry: RemoteControlOperationEntry<T> = {
      fingerprint,
      promise: Promise.resolve().then(work),
      settled: false,
    }
    /*
     * The failure is remembered too, and that is the whole point of an operationId: work that threw
     * may still have done half of what it does. Forgetting it - which is what this store did until
     * 2026-08-23 - turns the retry the caller is told to send into a second side effect.
     */
    entry.promise.catch(() => undefined)
    this.entries.set(key, entry as RemoteControlOperationEntry<unknown>)
    try {
      const value = await entry.promise
      entry.settled = true
      return { kind: 'value', value }
    } catch (error) {
      entry.settled = true
      throw error
    }
  }

  /**
   * The same run with its two refusals already worded.
   *
   * Three callers - the control API, the local API and the socket protocol - turned `conflict` and
   * `full` into a response each, which was three copies of the same two sentences and three chances
   * for them to drift apart. What differs between the callers is the envelope, not the words.
   */
  async runOrRefuse<T>(
    callerId: string,
    operationId: string,
    fingerprint: string,
    work: () => Promise<T>,
  ): Promise<RemoteControlStepResult<T>> {
    const stored = await this.run(callerId, operationId, fingerprint, work)
    if (stored.kind === 'value') return { ok: true, value: stored.value }
    else if (stored.kind === 'conflict')
      return {
        ok: false,
        error: {
          code: 'conflict',
          detail: `operationId ${JSON.stringify(operationId)} was already used for another request`,
        },
      }
    else if (stored.kind === 'full')
      return {
        ok: false,
        error: { code: 'unavailable', detail: 'The operation replay store is full' },
      }
    else
      throw new Error(`Unknown operation store result: ${JSON.stringify(stored)}`)
  }

  private makeRoom(): boolean {
    if (this.entries.size < this.limit) return true
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue
      this.entries.delete(key)
      return true
    }
    return false
  }
}

