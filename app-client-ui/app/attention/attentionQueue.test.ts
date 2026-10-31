import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttentionKind } from '../../shared/attention'
import { AttentionQueue, type AttentionEntry } from './attentionQueue'

/** A workspace of panels, one of them in front, and the entries a test hands in. */
class QueueHarness {
  front: string | null = 'original'
  focused = true
  idle = 20_000
  returnEnabled = true
  returnWindow: number | null = 300_000
  clock = 0
  readonly shown: string[] = []
  readonly focusedPanels: string[] = []
  readonly reports: string[] = []
  changes = 0
  readonly wanted = new Map<string, boolean>()
  readonly queue: AttentionQueue

  constructor() {
    this.queue = new AttentionQueue({
      front: () => this.focused ? { panelId: this.front } : null,
      lastActivePanel: () => this.front,
      focus: async (panelId) => {
        this.focusedPanels.push(panelId)
        this.front = panelId
      },
      idleMilliseconds: () => this.idle,
      returnEnabled: () => this.returnEnabled,
      returnWindowMilliseconds: () => this.returnWindow,
      onChanged: () => { this.changes += 1 },
      report: (message) => this.reports.push(message),
      now: () => this.clock,
    })
  }

  entry(key: string, options: { kind?: AttentionKind; automatic?: boolean; holds?: boolean; refuse?: true } = {}): AttentionEntry {
    this.wanted.set(key, true)
    return { key, kind: options.kind ?? 'commit-review', sessionId: key, title: `Title ${key}`, automatic: options.automatic ?? true,
      holds: options.holds ?? true, wanted: () => this.wanted.get(key) === true,
      show: async () => {
        if (options.refuse) return null
        this.shown.push(key)
        this.front = key
        return key
      } }
  }

  /** The person types: the clock moves and the queue hears it. */
  type(at: number): void {
    this.clock = at
    this.queue.personActive()
  }

  done(key: string): void {
    this.wanted.set(key, false)
    this.queue.changed()
  }

  async settled(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
  }

  async wait(milliseconds: number): Promise<void> {
    this.clock += milliseconds
    await vi.advanceTimersByTimeAsync(milliseconds)
  }
}

describe('app-client-ui/app/attention/attentionQueue', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('holds an item while the person types and brings it forward after the quiet time', async () => {
    const h = new QueueHarness()
    h.type(1_000)
    h.queue.add(h.entry('review'))
    await h.settled()
    expect(h.shown).toEqual([])
    expect(h.queue.snapshot().items).toMatchObject([{ key: 'review', kind: 'commit-review', automatic: true, title: 'Title review' }])

    await h.wait(15_000)
    h.type(16_000)
    await h.wait(19_999)
    expect(h.shown).toEqual([])
    await h.wait(1)
    expect(h.shown).toEqual(['review'])
    expect(h.queue.snapshot().items).toEqual([])
  })

  it('brings an item forward at once after the quiet time has already passed', async () => {
    const h = new QueueHarness()
    h.type(0)
    h.clock = 20_000
    h.queue.add(h.entry('review'))
    await h.settled()
    expect(h.shown).toEqual(['review'])
  })

  it('brings the first waiting item forward on a click, while the person types', async () => {
    const h = new QueueHarness()
    h.type(1_000)
    h.queue.add(h.entry('mark', { kind: 'session-mark', automatic: false, holds: false }))
    h.queue.add(h.entry('review'))
    expect(h.queue.snapshot().items.map((item) => item.key)).toEqual(['review', 'mark'])
    await h.queue.next()
    expect(h.shown).toEqual(['review'])
    await h.queue.next()
    expect(h.shown).toEqual(['review', 'mark'])
    expect(h.queue.snapshot().items).toEqual([])
  })

  it('never brings an item forward by itself that waits for a click', async () => {
    const h = new QueueHarness()
    h.idle = 0
    h.queue.add(h.entry('mark', { kind: 'session-mark', automatic: false, holds: false }))
    await h.wait(60_000)
    expect(h.shown).toEqual([])
    h.done('mark')
    await h.settled()
    expect(h.queue.snapshot().items).toEqual([])
  })

  it('waits while no workspace has the focus, and measures again from the focus coming back', async () => {
    const h = new QueueHarness()
    h.focused = false
    h.queue.add(h.entry('review'))
    await h.wait(60_000)
    expect(h.shown).toEqual([])
    h.focused = true
    h.type(h.clock)
    await h.wait(19_999)
    expect(h.shown).toEqual([])
    await h.wait(1)
    expect(h.shown).toEqual(['review'])
  })

  it('holds the next item until the one in front is done, then moves on at once and returns after the last', async () => {
    const h = new QueueHarness()
    h.idle = 0
    h.queue.add(h.entry('one'))
    await h.settled()
    h.type(5_000)
    h.queue.add(h.entry('two'))
    await h.wait(60_000)
    expect(h.shown).toEqual(['one'])

    h.done('one')
    await h.settled()
    expect(h.shown).toEqual(['one', 'two'])
    h.done('two')
    await h.settled()
    expect(h.focusedPanels).toEqual(['original'])
  })

  it('releases the queue when the person leaves an unfinished item, without a return', async () => {
    const h = new QueueHarness()
    h.idle = 0
    h.queue.add(h.entry('one'))
    await h.settled()
    h.front = 'elsewhere'
    h.queue.add(h.entry('two'))
    await h.settled()
    expect(h.shown).toEqual(['one', 'two'])
    h.done('one')
    h.done('two')
    await h.settled()
    expect(h.focusedPanels).toEqual(['elsewhere'])
  })

  it('does not return after the return window or with the return off, and still moves on', async () => {
    for (const mode of ['expired', 'disabled'] as const) {
      const h = new QueueHarness()
      h.idle = 0
      h.returnEnabled = mode !== 'disabled'
      h.queue.add(h.entry('one'))
      h.queue.add(h.entry('two'))
      await h.settled()
      h.clock = 300_001
      h.done('one')
      await h.settled()
      h.done('two')
      await h.settled()
      expect(h.shown).toEqual(['one', 'two'])
      expect(h.focusedPanels).toEqual([])
    }
  })

  it('ends with an item that does not hold, and the next waits for the quiet time again', async () => {
    const h = new QueueHarness()
    h.queue.add(h.entry('opened', { kind: 'session-opened', holds: false }))
    h.queue.add(h.entry('review'))
    await h.settled()
    expect(h.shown).toEqual(['opened'])
    await h.wait(19_999)
    expect(h.shown).toEqual(['opened'])
    await h.wait(1)
    expect(h.shown).toEqual(['opened', 'review'])
    h.done('review')
    await h.settled()
    expect(h.focusedPanels).toEqual(['opened'])
  })

  it('drops an item it could not show and stops the sequence there', async () => {
    const h = new QueueHarness()
    h.idle = 0
    h.queue.add(h.entry('one'))
    await h.settled()
    h.queue.add(h.entry('refused', { refuse: true }))
    h.queue.add(h.entry('three'))
    h.idle = 20_000
    h.done('one')
    await h.settled()
    expect(h.queue.snapshot().items.map((item) => item.key)).toEqual(['three'])
    expect(h.focusedPanels).toEqual([])
    await h.wait(20_000)
    expect(h.shown).toEqual(['one', 'three'])
  })

  it('takes out a waiting item that is no longer wanted, and ignores a second copy of a waiting one', async () => {
    const h = new QueueHarness()
    h.type(0)
    h.queue.add(h.entry('one'))
    h.queue.add(h.entry('one'))
    h.queue.add(h.entry('two'))
    expect(h.queue.snapshot()).toMatchObject({ revision: 2, items: [{ key: 'one' }, { key: 'two' }] })
    h.done('one')
    await h.settled()
    expect(h.queue.snapshot()).toMatchObject({ revision: 3, items: [{ key: 'two' }] })
    expect(h.changes).toBe(3)
  })

  it('reports a source that throws and goes on without its item', async () => {
    const h = new QueueHarness()
    h.idle = 0
    h.queue.add({ ...h.entry('broken'), wanted: () => { throw new Error('gone') } })
    h.queue.add(h.entry('fine'))
    await h.settled()
    expect(h.shown).toEqual(['fine'])
    expect(h.reports).toEqual(['Title broken could not be read for the attention queue: gone'])
  })

  it('forgets everything and takes nothing more once stopped', async () => {
    const h = new QueueHarness()
    h.queue.add(h.entry('one'))
    h.queue.stop()
    h.queue.add(h.entry('two'))
    await h.wait(60_000)
    expect(h.shown).toEqual([])
    expect(h.queue.snapshot().items).toEqual([])
  })
})
