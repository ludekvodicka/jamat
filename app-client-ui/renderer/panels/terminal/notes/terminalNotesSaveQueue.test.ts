import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryNote } from '../../../../shared/directoryNotes'
import { TerminalNotesSaveQueue } from './terminalNotesSaveQueue'
import type { TerminalNotesSaveOutcome } from './terminalNotesSaveQueue'

describe('app-client-ui/renderer/panels/terminal/notes/terminalNotesSaveQueue', () => {
  interface Write {
    notes: readonly DirectoryNote[]
    settle(outcome: TerminalNotesSaveOutcome): void
  }

  let writes: Write[]
  let outcomes: TerminalNotesSaveOutcome[]
  let queue: TerminalNotesSaveQueue

  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
    outcomes = []
    queue = new TerminalNotesSaveQueue(
      (notes) => new Promise((resolve) => { writes.push({ notes, settle: resolve }) }),
      (outcome) => outcomes.push(outcome),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function notes(text: string): DirectoryNote[] {
    return [{ text }]
  }

  async function settle(write: Write, outcome: TerminalNotesSaveOutcome): Promise<void> {
    write.settle(outcome)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('restarts the 500 ms wait on every edit and writes the newest state once', async () => {
    queue.schedule(notes('a'))
    await vi.advanceTimersByTimeAsync(400)
    queue.schedule(notes('ab'))
    await vi.advanceTimersByTimeAsync(400)
    expect(writes).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(100)

    expect(writes.map((write) => write.notes)).toEqual([notes('ab')])
  })

  it('keeps one write in flight and merges what waits behind it to the newest', async () => {
    queue.schedule(notes('a'))
    await vi.advanceTimersByTimeAsync(500)
    queue.schedule(notes('ab'))
    queue.schedule(notes('abc'))
    await vi.advanceTimersByTimeAsync(500)
    expect(writes).toHaveLength(1)

    await settle(writes[0], { ok: true })

    expect(writes.map((write) => write.notes)).toEqual([notes('a'), notes('abc')])
  })

  it('counts pending and in-flight state as dirty', async () => {
    expect(queue.dirty()).toBe(false)
    queue.schedule(notes('a'))
    expect(queue.dirty()).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(queue.dirty()).toBe(true)

    await settle(writes[0], { ok: true })

    expect(queue.dirty()).toBe(false)
    expect(outcomes).toEqual([{ ok: true }])
  })

  it('ends a flush during a write in flight with the newer state written', async () => {
    queue.schedule(notes('a'))
    await vi.advanceTimersByTimeAsync(500)
    queue.schedule(notes('ab'))

    let flushed: TerminalNotesSaveOutcome | null = null
    void queue.flush().then((outcome) => { flushed = outcome })
    await settle(writes[0], { ok: true })
    expect(flushed).toBeNull()
    expect(writes.map((write) => write.notes)).toEqual([notes('a'), notes('ab')])

    await settle(writes[1], { ok: true })

    expect(flushed).toEqual({ ok: true })
    expect(queue.dirty()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toHaveLength(2)
  })

  it('keeps a failed write dirty, reports it, and a retry writes the newest state', async () => {
    queue.schedule(notes('a'))
    await vi.advanceTimersByTimeAsync(500)

    await settle(writes[0], { ok: false, detail: 'config latched' })

    expect(queue.dirty()).toBe(true)
    expect(outcomes).toEqual([{ ok: false, detail: 'config latched' }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toHaveLength(1)

    queue.schedule(notes('ab'))
    const retried = queue.flush()
    expect(writes.map((write) => write.notes)).toEqual([notes('a'), notes('ab')])
    await settle(writes[1], { ok: true })

    await expect(retried).resolves.toEqual({ ok: true })
    expect(queue.dirty()).toBe(false)
  })

  it('stops a flush after its own write failed', async () => {
    queue.schedule(notes('a'))

    const flushed = queue.flush()
    await settle(writes[0], { ok: false, detail: 'gone' })

    await expect(flushed).resolves.toEqual({ ok: false, detail: 'gone' })
    expect(writes).toHaveLength(1)
  })

  it('writes the last pending state once on dispose and reports nothing after it', async () => {
    queue.schedule(notes('a'))
    await vi.advanceTimersByTimeAsync(500)
    queue.schedule(notes('ab'))

    queue.dispose()
    queue.dispose()
    queue.schedule(notes('abc'))
    await settle(writes[0], { ok: true })
    await settle(writes[1], { ok: false, detail: 'late' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(writes.map((write) => write.notes)).toEqual([notes('a'), notes('ab')])
    expect(outcomes).toEqual([])
  })

  it('writes a pending state right away on dispose', () => {
    queue.schedule(notes('a'))

    queue.dispose()

    expect(writes.map((write) => write.notes)).toEqual([notes('a')])
  })
})
