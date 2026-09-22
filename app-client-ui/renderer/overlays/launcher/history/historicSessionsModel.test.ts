import { describe, expect, it } from 'vitest'

import type { HistoricSession } from '../../../../shared/historicSessions'
import { HistoricSessionsModel } from './historicSessionsModel'

describe('app-client-ui/renderer/overlays/launcher/history/historicSessionsModel', () => {
  const rootConst = { id: 'root', label: 'Applications', path: 'Q:/Apps' }
  const projectConst = { name: 'App', path: 'Q:/Apps/App' }

  function session(nativeSessionId: string, ending: Partial<HistoricSession>): HistoricSession {
    return { nativeSessionId, agentId: 'claude', title: nativeSessionId, firstUserMessage: null,
      model: null, createdAt: 1_000, lastActivity: null, endedAt: null, active: false, ...ending }
  }

  /**
   * Ended is what this list is read by, so every row has to answer it. A recorded ending is the
   * answer; the last use is the closest guess and is marked as one; a row with neither says so and
   * falls back to its creation for the order alone.
   */
  it('orders by the recorded ending and falls back to the last use where none was recorded', () => {
    const rows = HistoricSessionsModel.rows(rootConst, projectConst, [
      session('ended-early', { endedAt: 2_000 }),
      session('guessed', { lastActivity: 5_000 }),
      session('ended-late', { endedAt: 9_000, lastActivity: 1_500 }),
      session('nothing', { createdAt: 700 }),
    ])

    const sorted = HistoricSessionsModel.sorted(rows)

    expect(sorted.map((row) => row.nativeSessionId))
      .toEqual(['ended-late', 'guessed', 'ended-early', 'nothing'])
    const labels = new Map(sorted.map((row) => [row.nativeSessionId, row.endedLabel]))
    expect(labels.get('nothing')).toBe('Unknown')
    expect(labels.get('guessed')?.startsWith('~')).toBe(true)
    expect(labels.get('ended-late')?.startsWith('~')).toBe(false)
    // The cell points at the instant it drew, and at nothing when it drew no instant.
    expect(sorted.map((row) => row.endedInstant)).toEqual([9_000, 5_000, 2_000, null])
  })

  /**
   * A conversation is found by the one thing a person actually has: the name of its transcript on
   * disk. That name arrives bare, with its suffix, with Codex's timestamp in front of it, or as a
   * whole path pasted out of a file manager, and all four mean the same session.
   */
  it.each([
    ['the bare id', 'dc63c569-7450-484a-a1d7-6087385e4c9a'],
    ['a Claude transcript name', 'dc63c569-7450-484a-a1d7-6087385e4c9a.jsonl'],
    ['a Codex rollout name', 'rollout-2026-09-21T10-42-55-dc63c569-7450-484a-a1d7-6087385e4c9a.jsonl'],
    ['a pasted Windows path', 'C:\\Users\\x\\.claude\\projects\\Q--Apps-App\\dc63c569-7450-484a-a1d7-6087385e4c9a.jsonl'],
    ['a pasted POSIX path', '/home/x/.claude/projects/app/dc63c569-7450-484a-a1d7-6087385e4c9a.jsonl'],
    ['the id in capitals', 'DC63C569-7450-484A-A1D7-6087385E4C9A'],
  ])('finds a session by %s', (_what, query) => {
    const rows = HistoricSessionsModel.rows(rootConst, projectConst, [
      session('dc63c569-7450-484a-a1d7-6087385e4c9a', { title: '014 - the fork' }),
      session('99999999-0000-0000-0000-000000000000', { title: '015 - another' }),
    ])

    expect(HistoricSessionsModel.filtered(rows, query).map((row) => row.nativeSessionId))
      .toEqual(['dc63c569-7450-484a-a1d7-6087385e4c9a'])
  })

  it('finds a session by the name it was given, whole or in part', () => {
    const rows = HistoricSessionsModel.rows(rootConst, projectConst, [
      session('a1111111-1111-1111-1111-111111111111', { title: '014 - the fork' }),
      session('b2222222-2222-2222-2222-222222222222', { title: '015 - something else' }),
    ])

    expect(HistoricSessionsModel.filtered(rows, 'the fork').map((row) => row.title))
      .toEqual(['014 - the fork'])
    expect(HistoricSessionsModel.filtered(rows, '015').map((row) => row.title))
      .toEqual(['015 - something else'])
  })

  // A path typed to narrow the list by project is still a path, not a file name to be cut down.
  it('leaves an ordinary word alone', () => {
    const rows = HistoricSessionsModel.rows(rootConst, projectConst, [
      session('c3333333-3333-3333-3333-333333333333', { title: 'kept' }),
    ])

    expect(HistoricSessionsModel.filtered(rows, 'Q:/Apps/App')).toHaveLength(1)
    expect(HistoricSessionsModel.filtered(rows, 'nothing-like-this')).toHaveLength(0)
  })

  it.each([
    ['1d', '2026-09-12T14:30:00Z'],
    ['2d', '2026-09-11T14:30:00Z'],
    ['7d', '2026-09-06T14:30:00Z'],
    ['1m', '2026-08-14T14:30:00Z'],
    ['all', null],
  ] as const)('uses a rolling last-use cutoff for %s', (range, expected) => {
    expect(HistoricSessionsModel.lastUsedSince(range, Date.parse('2026-09-13T14:30:00Z')))
      .toBe(expected === null ? null : Date.parse(expected))
  })
})
