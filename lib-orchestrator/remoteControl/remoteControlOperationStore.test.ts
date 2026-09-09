import { describe, expect, it } from 'vitest'

import { RemoteControlOperationStore } from './remoteControlOperationStore'

describe('lib-orchestrator/remoteControl/remoteControlOperationStore', () => {
  it('shares an in-flight result between retries and runs the mutation once', async () => {
    const store = new RemoteControlOperationStore()
    let release!: (value: string) => void
    const pending = new Promise<string>((resolve) => { release = resolve })
    let runs = 0
    const work = () => {
      runs += 1
      return pending
    }

    const first = store.run('caller', 'operation', 'same', work)
    const retry = store.run('caller', 'operation', 'same', work)
    release('answer')

    await expect(first).resolves.toEqual({ kind: 'value', value: 'answer' })
    await expect(retry).resolves.toEqual({ kind: 'value', value: 'answer' })
    expect(runs).toBe(1)
  })

  it('separates callers and refuses a reused id with another fingerprint', async () => {
    const store = new RemoteControlOperationStore()
    expect(await store.run('one', 'operation', 'first', async () => 1))
      .toEqual({ kind: 'value', value: 1 })
    expect(await store.run('one', 'operation', 'second', async () => 2))
      .toEqual({ kind: 'conflict' })
    expect(await store.run('two', 'operation', 'second', async () => 2))
      .toEqual({ kind: 'value', value: 2 })
  })

  it('evicts the oldest settled entry but never an in-flight operation', async () => {
    const store = new RemoteControlOperationStore(1)
    expect(await store.run('caller', 'one', 'one', async () => 1))
      .toEqual({ kind: 'value', value: 1 })
    expect(await store.run('caller', 'two', 'two', async () => 2))
      .toEqual({ kind: 'value', value: 2 })
    expect(await store.run('caller', 'one', 'changed', async () => 3))
      .toEqual({ kind: 'value', value: 3 })

    let release!: () => void
    const held = store.run('caller', 'pending', 'pending', () =>
      new Promise<void>((resolve) => { release = resolve }))
    expect(await store.run('caller', 'blocked', 'blocked', async () => 4))
      .toEqual({ kind: 'full' })
    release()
    await expect(held).resolves.toEqual({ kind: 'value', value: undefined })
  })

  it('rejects invalid limits', () => {
    expect(() => new RemoteControlOperationStore(0)).toThrow('Invalid operation store limit')
    expect(() => new RemoteControlOperationStore(1.5)).toThrow('Invalid operation store limit')
  })

  /*
   * An operationId exists so a retry is not a second side effect, and work that THREW is exactly
   * when that matters: it may have done half of what it does. Forgetting the failure - which this
   * store did until 2026-08-23, deliberately and with a test saying so - turned the retry the caller
   * is told to send into the second half. A caller that wants a fresh attempt sends a fresh
   * operationId, which is what the CLI does on every invocation.
   */
  it('remembers a mutation that threw rather than running it again', async () => {
    const store = new RemoteControlOperationStore()
    let runs = 0
    const work = async (): Promise<never> => {
      runs += 1
      await Promise.resolve()
      throw new Error('the session was created and the tab was not')
    }

    await expect(store.run('caller', 'op-1', 'fingerprint', work))
      .rejects.toThrow('the session was created and the tab was not')
    await expect(store.run('caller', 'op-1', 'fingerprint', work))
      .rejects.toThrow('the session was created and the tab was not')

    expect(runs).toBe(1)
  })
})

