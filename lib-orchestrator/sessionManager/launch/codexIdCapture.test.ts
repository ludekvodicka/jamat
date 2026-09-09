import { describe, expect, it } from 'vitest'

import type { CodexRolloutMatch } from '../../projectManager/codexRolloutView'
import type { SessionRecord } from '../records/sessionRecord.types'
import { CodexIdCapture } from './codexIdCapture'

describe('lib-orchestrator/sessionManager/launch/codexIdCapture', () => {
  function record(overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'agent',
      title: 's1',
      directory: { mode: 'default' },
      agent: { agentId: 'codex', launchMode: 'new' },
      binding: null,
      life: 'lost',
      createdAt: 5_000,
      ...overrides,
    }
  }

  /** A conversation nobody forked names no parent, which is what most candidates are. */
  function rollout(
    sessionId: string,
    createdAt: number,
    forkedFromId: string | null = null,
  ): CodexRolloutMatch {
    return { sessionId, createdAt, forkedFromId }
  }

  it('claims the one rollout written in the launch window', () => {
    const found = [rollout('conv-1', 5_100)]
    expect(CodexIdCapture.matchOf(found, record(), [record()])).toBe('conv-1')
  })

  // Two conversations in one directory in one window is exactly the case the strict refusal exists
  // for: either could be this session's, and picking one would be silent.
  it('claims nothing when more than one rollout fits', () => {
    const found = [rollout('conv-1', 5_100), rollout('conv-2', 5_200)]
    expect(CodexIdCapture.matchOf(found, record(), [record()])).toBeNull()
  })

  it('ends the window five minutes after launch even when the session lived longer', () => {
    const ended = record({ endedAt: 1_000_000 })
    expect(CodexIdCapture.matchOf([rollout('conv-1', 305_001)], ended, [ended])).toBeNull()
    expect(CodexIdCapture.matchOf([rollout('conv-1', 305_000)], ended, [ended]))
      .toBe('conv-1')
  })

  it('keeps one minute of clock slack before launch, including its exact edge', () => {
    expect(CodexIdCapture.matchOf([rollout('conv-1', -55_001)], record(), [record()]))
      .toBeNull()
    expect(CodexIdCapture.matchOf([rollout('conv-1', -55_000)], record(), [record()]))
      .toBe('conv-1')
  })

  it('ignores a rollout another record already holds', () => {
    const mine = record()
    const other = record({ sessionId: 's2', agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'conv-1' } })
    expect(CodexIdCapture.matchOf([rollout('conv-1', 5_100)], mine, [mine, other]))
      .toBeNull()
  })

  // The Host refused the launch, so Codex never ran and wrote nothing; a candidate in the window
  // can only belong to something else.
  it('claims nothing for a record whose launch never ran', () => {
    const refused = record({ endedReason: 'the Host said no' })
    expect(CodexIdCapture.matchOf([rollout('conv-1', 5_100)], refused, [refused]))
      .toBeNull()
  })

  it('claims nothing when the directory holds no rollouts at all', () => {
    expect(CodexIdCapture.matchOf([], record(), [record()])).toBeNull()
  })

  /** A fork record, launched from `conv-1`, the shape every lineage case below is a variation of. */
  function forkRecord(overrides?: Partial<SessionRecord>): SessionRecord {
    return record({
      agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1' },
      ...overrides,
    })
  }

  // The header names the parent, so a fork and a fresh session started beside it are two candidates
  // that used to be indistinguishable and now are not.
  it('claims the rollout whose header names the conversation this fork was cut from', () => {
    const mine = forkRecord()
    const found = [rollout('conv-2', 5_100, 'conv-1'), rollout('conv-3', 5_100)]
    expect(CodexIdCapture.matchOf(found, mine, [mine])).toBe('conv-2')
  })

  it('claims nothing when the only candidate names another parent', () => {
    const mine = forkRecord()
    expect(CodexIdCapture.matchOf([rollout('conv-2', 5_100, 'conv-9')], mine, [mine])).toBeNull()
  })

  // A rollout whose own id is the parent is the parent's file, whatever its header says about a
  // fork of its own; claiming it would give two records one conversation.
  it('never claims the parent\'s own rollout for its fork', () => {
    const mine = forkRecord()
    expect(CodexIdCapture.matchOf([rollout('conv-1', 5_100, 'conv-1')], mine, [mine])).toBeNull()
  })

  // The same limit two `new` sessions in one window have, for the same reason.
  it('claims nothing when one parent was forked twice inside one window', () => {
    const mine = forkRecord()
    const found = [rollout('conv-2', 5_100, 'conv-1'), rollout('conv-3', 5_200, 'conv-1')]
    expect(CodexIdCapture.matchOf(found, mine, [mine])).toBeNull()
  })

  // The other direction of the same check: forking is what people do next in a directory they are
  // already working in, so a fresh session must not claim the fork's rollout.
  it('never claims a forked rollout for a fresh conversation', () => {
    expect(CodexIdCapture.matchOf([rollout('conv-2', 5_100, 'conv-1')], record(), [record()]))
      .toBeNull()
  })

  it('claims nothing for a continue or a resume, whatever is in the window', () => {
    for (const launchMode of ['continue', 'resume'] as const) {
      const mine = record({ agent: { agentId: 'codex', launchMode } })
      expect(CodexIdCapture.matchOf(
        [rollout('conv-2', 5_100), rollout('conv-3', 5_100, 'conv-1')], mine, [mine],
      ), launchMode).toBeNull()
    }
  })

  // A fork of a fork: the grandchild names the child, and the child's own id is already taken.
  it('claims the grandchild rollout for a fork of a fork', () => {
    const child = record({
      sessionId: 's2',
      agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1', nativeSessionId: 'conv-2' },
    })
    const mine = forkRecord({ agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-2' } })
    const found = [rollout('conv-2', 5_050, 'conv-1'), rollout('conv-3', 5_100, 'conv-2')]
    expect(CodexIdCapture.matchOf(found, mine, [mine, child])).toBe('conv-3')
  })

  it('throws on a launch mode it does not know', () => {
    const unknown = record({
      agent: { agentId: 'codex', launchMode: 'branch' } as unknown as SessionRecord['agent'],
    })
    expect(() => CodexIdCapture.matchOf([rollout('conv-1', 5_100)], unknown, [unknown]))
      .toThrow(/Unknown launch mode/)
    expect(() => CodexIdCapture.discoverable(unknown)).toThrow(/Unknown launch mode/)
  })

  describe('discoverable', () => {
    it('answers for exactly the records a rollout could still be claimed for', () => {
      expect(CodexIdCapture.discoverable(record())).toBe(true)
      expect(CodexIdCapture.discoverable(forkRecord())).toBe(true)
      expect(CodexIdCapture.discoverable(record({
        agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'conv-1' },
      }))).toBe(false)
      expect(CodexIdCapture.discoverable(forkRecord({
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1', nativeSessionId: 'conv-2' },
      }))).toBe(false)
      for (const launchMode of ['continue', 'resume'] as const)
        expect(CodexIdCapture.discoverable(record({ agent: { agentId: 'codex', launchMode } })), launchMode)
          .toBe(false)
      // Claude names its own conversations at launch; nothing is ever gone and found for one.
      expect(CodexIdCapture.discoverable(record({ agent: { agentId: 'claude', launchMode: 'new' } })))
        .toBe(false)
      expect(CodexIdCapture.discoverable(record({ kind: 'shell', agent: undefined }))).toBe(false)
    })
  })
})
