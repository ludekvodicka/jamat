import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordWorktreeCleanup } from '../records/sessionRecord.types'
import { WorktreeCleanupPacing } from './worktreeCleanupPacing'

describe('lib-orchestrator/sessionManager/lifecycle/worktreeCleanupPacing', () => {
  const minute = 60_000

  function cleanup(overrides?: Partial<SessionRecordWorktreeCleanup>): SessionRecordWorktreeCleanup {
    return { phase: 'pending', trigger: 'committed', requestedAt: 0, attempts: 0, ...overrides }
  }

  function ended(endedAt?: number): SessionRecord {
    return {
      sessionId: 's1', kind: 'shell', title: 's1', directory: { mode: 'default' }, binding: null, life: 'ended', createdAt: 0,
      ...endedAt === undefined ? {} : { endedAt },
    }
  }

  it('writes a fresh pending cleanup and counts each attempt', () => {
    const fresh = WorktreeCleanupPacing.pending('remove-when-ended', 7)
    expect(fresh).toEqual({ phase: 'pending', trigger: 'remove-when-ended', requestedAt: 7, attempts: 0 })
    expect(WorktreeCleanupPacing.attempted(fresh, 9)).toEqual({ ...fresh, attempts: 1, lastAttemptAt: 9 })
  })

  it('waits thirty seconds after the end, and counts from the client start when the record names no end', () => {
    expect(WorktreeCleanupPacing.settled(ended(1_000), 30_999, 0)).toBe(false)
    expect(WorktreeCleanupPacing.settled(ended(1_000), 31_000, 0)).toBe(true)
    expect(WorktreeCleanupPacing.settled(ended(), 20_000, 5_000)).toBe(false)
    expect(WorktreeCleanupPacing.settled(ended(), 35_000, 5_000)).toBe(true)
  })

  it('judges a cleanup never attempted at once, and never a kept one', () => {
    expect(WorktreeCleanupPacing.due(cleanup(), 0, 0)).toBe(true)
    expect(WorktreeCleanupPacing.due(cleanup({ phase: 'kept' }), 10 * minute, 0)).toBe(false)
  })

  it('spaces a holder or a failed read 0, 5 s, 30 s, 2 min, then 10 min', () => {
    const after = (attempts: number, since: number) =>
      WorktreeCleanupPacing.due(cleanup({ attempts, lastAttemptAt: 1_000, reason: 'in use' }), 1_000 + since, 0)
    expect(after(1, 0)).toBe(true)
    expect(after(2, 4_999)).toBe(false)
    expect(after(2, 5_000)).toBe(true)
    expect(after(3, 29_999)).toBe(false)
    expect(after(3, 30_000)).toBe(true)
    expect(after(4, 2 * minute - 1)).toBe(false)
    expect(after(4, 2 * minute)).toBe(true)
    expect(after(5, 10 * minute - 1)).toBe(false)
    expect(after(40, 10 * minute)).toBe(true)
  })

  it('asks about an unlanded commit every ten minutes from the first time', () => {
    const waiting = cleanup({ attempts: 1, lastAttemptAt: 1_000, reason: 'unlanded r12: src/a.txt' })
    expect(WorktreeCleanupPacing.due(waiting, 1_000 + 10 * minute - 1, 0)).toBe(false)
    expect(WorktreeCleanupPacing.due(waiting, 1_000 + 10 * minute, 0)).toBe(true)
  })

  it('makes the first judgement after a client start due, whatever the wait', () => {
    const waiting = cleanup({ attempts: 1, lastAttemptAt: 1_000, reason: 'unlanded r12: src/a.txt' })
    expect(WorktreeCleanupPacing.due(waiting, 2_000, 1_500)).toBe(true)
    expect(WorktreeCleanupPacing.due({ ...waiting, lastAttemptAt: 1_600 }, 2_000, 1_500)).toBe(false)
  })

  it('does not park a cleanup behind a clock that went backwards', () => {
    expect(WorktreeCleanupPacing.due(cleanup({ attempts: 5, lastAttemptAt: 9_000, reason: 'in use' }), 1_000, 0)).toBe(true)
  })

  it('names the newest unlanded revision and at most five paths', () => {
    expect(WorktreeCleanupPacing.unlandedReason([{ path: 'a', revision: 11 }, { path: 'b', revision: 12 }]))
      .toBe('unlanded r12: a b')
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((path) => ({ path, revision: 3 }))
    expect(WorktreeCleanupPacing.unlandedReason(many)).toBe('unlanded r3: a b c d e (+2 more)')
  })

  it('says why a worktree is still there in the words a row, a tab and a script show', () => {
    const summary = (phase: 'pending' | 'kept', reason?: string) =>
      WorktreeCleanupPacing.summaryOf(reason === undefined ? { phase } : { phase, reason }, false)
    expect(summary('kept', '2 changes')).toBe('kept: 2 changes')
    expect(summary('pending', 'in use')).toBe('waiting to remove (in use)')
    expect(summary('pending', 'unlanded r4127: src/a.txt'))
      .toBe('r4127 is not in the main copy; Finish brings it in and removes the worktree')
    expect(summary('pending', 'undeleted')).toBe('waiting to remove (undeleted)')
    expect(summary('pending')).toBe('removed once the session has ended and nothing is left in it')
    expect(() => summary('gone' as 'kept')).toThrow(/Unknown cleanup phase/)
  })

  it('says a cleanup waits on an end it cannot confirm, which no reason it has outranks', () => {
    for (const exitReason of ['host-lost', undefined] as const) {
      const record = { ...ended(1_000), ...exitReason === undefined ? {} : { exitReason } }
      expect(WorktreeCleanupPacing.endUnconfirmed(record)).toBe(true)
      expect(WorktreeCleanupPacing.summaryOf({ phase: 'pending', reason: 'in use' }, WorktreeCleanupPacing.endUnconfirmed(record)))
        .toBe('waiting: the end of the session is not confirmed')
    }
    expect(WorktreeCleanupPacing.summaryOf({ phase: 'kept', reason: '2 changes' }, true)).toBe('kept: 2 changes')
    for (const exitReason of ['process-exit', 'stopped', 'spawn-failed'] as const)
      expect(WorktreeCleanupPacing.endUnconfirmed({ ...ended(1_000), exitReason })).toBe(false)
    expect(WorktreeCleanupPacing.endUnconfirmed({ ...ended(), life: 'lost' })).toBe(false)
    expect(WorktreeCleanupPacing.endUnconfirmed({ ...ended(), life: 'live' })).toBe(false)
  })

  it('counts a process gone once it exited, was stopped, never spawned or was lost', () => {
    const gone = (overrides: Partial<SessionRecord>) => WorktreeCleanupPacing.processGone({ ...ended(1_000), ...overrides })
    expect(gone({ exitReason: 'process-exit' })).toBe(true)
    expect(gone({ exitReason: 'stopped' })).toBe(true)
    expect(gone({ exitReason: 'spawn-failed' })).toBe(true)
    expect(gone({ exitReason: 'host-lost' })).toBe(false)
    expect(gone({})).toBe(false)
    expect(gone({ life: 'lost' })).toBe(true)
    expect(gone({ life: 'live' })).toBe(false)
    expect(gone({ life: 'starting' })).toBe(false)
    expect(() => gone({ exitReason: 'vanished' as 'stopped' })).toThrow(/Unknown exit reason/)
  })

  it('turns an unfinished Discard into a change-checking request at a launch, and leaves every other cleanup alone', () => {
    const discarded = { ...ended(1_000), worktreeCleanup: cleanup({ trigger: 'discard-unfinished', reason: 'in use', attempts: 3, lastAttemptAt: 9 }) }
    const relaunched = WorktreeCleanupPacing.relaunched(discarded, 20)
    expect(relaunched.worktreeCleanup).toEqual({ phase: 'pending', trigger: 'removal-unfinished', requestedAt: 20, attempts: 0 })
    expect(WorktreeCleanupPacing.checksChanges(relaunched.worktreeCleanup?.trigger ?? 'discard-unfinished')).toBe(true)

    for (const trigger of ['committed', 'removal-unfinished', 'remove-when-ended'] as const) {
      const other = { ...ended(1_000), worktreeCleanup: cleanup({ trigger }) }
      expect(WorktreeCleanupPacing.relaunched(other, 20)).toBe(other)
    }
    const none = ended(1_000)
    expect(WorktreeCleanupPacing.relaunched(none, 20)).toBe(none)
    expect(() => WorktreeCleanupPacing.checksChanges('later' as 'committed')).toThrow(/Unknown cleanup trigger/)
  })

  it('reads an end after the request as a run after it, and a record without an end as none', () => {
    expect(WorktreeCleanupPacing.ranSince(ended(1_001), 1_000)).toBe(true)
    expect(WorktreeCleanupPacing.ranSince(ended(1_000), 1_000)).toBe(false)
    expect(WorktreeCleanupPacing.ranSince(ended(), 1_000)).toBe(false)
  })
})
