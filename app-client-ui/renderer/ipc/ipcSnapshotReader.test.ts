import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult } from '../../shared/appClientUiIpc'
import { IpcSnapshotReader } from './ipcSnapshotReader'

describe('app-client-ui/renderer/ipc/ipcSnapshotReader', () => {
  interface Reading {
    value: string
  }

  interface Harness {
    reader: IpcSnapshotReader<Reading>
    reads: () => number
    /** What the main process would push: something changed, read again. */
    push: () => void
    answers: Reading[]
    errors: (string | null)[]
    reported: string[]
    /** Answers the read that is out; until it is called the read is still in flight. */
    answer: (result: IpcResult<Reading>) => Promise<void>
    /** The other way a read can end: the invoke itself rejects, with no result to carry a reason. */
    reject: (thrown: unknown) => Promise<void>
  }

  function harness(): Harness {
    let reads = 0
    const pending: ((result: IpcResult<Reading>) => void)[] = []
    const refusals: ((thrown: unknown) => void)[] = []
    let notify: (() => void) | null = null
    const answers: Reading[] = []
    const errors: (string | null)[] = []
    const reported: string[] = []
    const reader = new IpcSnapshotReader<Reading>(
      {
        subject: 'The reading',
        read: () => {
          reads += 1
          return new Promise<IpcResult<Reading>>((resolve, reject) => {
            pending.push(resolve)
            refusals.push(reject)
          })
        },
        subscribe: (onChanged) => {
          notify = onChanged
          return () => { notify = null }
        },
        reportError: (message) => reported.push(message),
      },
      (snapshot) => answers.push(snapshot),
      (error) => errors.push(error),
    )
    return {
      reader,
      reads: () => reads,
      push: () => notify?.(),
      answers,
      errors,
      reported,
      answer: async (result) => {
        pending.shift()?.(result)
        refusals.shift()
        await vi.advanceTimersByTimeAsync(0)
      },
      reject: async (thrown) => {
        pending.shift()
        refusals.shift()?.(thrown)
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  const okConst: IpcResult<Reading> = { ok: true, value: { value: 'read' } }
  const failedConst: IpcResult<Reading> = { ok: false, error: 'the main process is gone' }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads once on start and again after a push', async () => {
    const context = harness()
    context.reader.start()
    expect(context.reads()).toBe(1)

    await context.answer(okConst)
    context.push()
    await vi.advanceTimersByTimeAsync(100)
    expect(context.reads()).toBe(2)
    expect(context.answers).toHaveLength(1)
  })

  // The push carries nothing, so a burst of them is one question asked five times.
  it('turns a burst of pushes into one read', async () => {
    const context = harness()
    context.reader.start()
    await context.answer(okConst)

    for (let push = 0; push < 5; push += 1) context.push()
    await vi.advanceTimersByTimeAsync(100)

    expect(context.reads()).toBe(2)
  })

  // Without the trailing read the user is left looking at the state BEFORE the change that was
  // pushed while the read was out.
  it('never has two reads out at once, and takes a trailing one', async () => {
    const context = harness()
    context.reader.start()

    context.push()
    context.push()
    await vi.advanceTimersByTimeAsync(100)
    // The first read has not answered, so nothing was asked a second time.
    expect(context.reads()).toBe(1)

    await context.answer(okConst)
    // The trailing read goes out immediately rather than waiting for another push.
    expect(context.reads()).toBe(2)
  })

  /*
   * V1's incident of 2026-06-11 is what an unbounded retry against a gone main process looks like.
   * The reader backs off, gives up, says so, and only `refresh` starts it again.
   */
  it('backs off, stops asking, and starts again only when refreshed', async () => {
    const context = harness()
    context.reader.start()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await context.answer(failedConst)
      await vi.advanceTimersByTimeAsync(5_000)
    }

    expect(context.reads()).toBe(5)
    expect(context.errors.at(-1)).toContain('stopped refreshing')
    expect(context.reported.at(-1)).toContain('The reading could not be read after 5 attempts')

    context.push()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.reads()).toBe(5)

    context.reader.refresh()
    expect(context.reads()).toBe(6)
    expect(context.errors.at(-1)).toBeNull()
  })

  /*
   * The other way a read ends. `ipcRenderer.invoke` REJECTS when the main process goes away
   * mid-call, and there is no result to carry a reason - so only the `.catch` puts `reading` back
   * down. Without it the reader is stuck in flight for ever: every push only sets `trailing`, the
   * window keeps drawing its last snapshot with nothing said, and `refresh()` cannot help either.
   */
  it('recovers from an invoke that rejects, and reads again', async () => {
    const context = harness()
    context.reader.start()

    await context.reject(new Error('the main process is gone'))

    expect(context.reported.at(-1)).toContain('the main process is gone')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(context.reads()).toBe(2)

    // And the retry answers normally, so the reader is fully back rather than merely asking again.
    await context.answer(okConst)
    expect(context.answers).toHaveLength(1)
    expect(context.errors.at(-1)).toBeNull()
  })

  // A rejection counts towards the same budget an `ok: false` does, and stops the reader the same way.
  it('gives up after five rejections and says so once', async () => {
    const context = harness()
    context.reader.start()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await context.reject(new Error('gone'))
      await vi.advanceTimersByTimeAsync(5_000)
    }

    expect(context.reads()).toBe(5)
    expect(context.errors.at(-1)).toContain('stopped refreshing')
  })

  it('asks nothing more once it is disposed', async () => {
    const context = harness()
    const dispose = context.reader.start()
    await context.answer(okConst)

    dispose()
    context.push()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(context.reads()).toBe(1)
  })
})
