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
    firstUserMessage: string | null = null,
  ): CodexRolloutMatch {
    return { sessionId, createdAt, forkedFromId, firstUserMessage }
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

  // Seen live 2026-09-23: two sessions a minute or two apart in one directory, both parked in Codex's
  // update menu. The later one's rollout appeared first and the earlier record, seeing exactly one
  // candidate, took it; the other rollout then went to the later record, and the two were swapped.
  describe('two unnamed sessions in one directory', () => {
    const directory = { mode: 'adHoc', path: 'E:\\work\\bind' } as const
    const first = record({ sessionId: 'first', directory, createdAt: 5_000 })
    const second = record({ sessionId: 'second', directory, createdAt: 125_000 })

    it('claims nothing while the only rollout could be either session', () => {
      const secondsRollout = [rollout('conv-second', 130_000)]
      expect(CodexIdCapture.matchOf(secondsRollout, first, [first, second])).toBeNull()
      expect(CodexIdCapture.matchOf(secondsRollout, second, [first, second])).toBeNull()
    })

    it('never ends swapped once both rollouts are on disk', () => {
      const both = [rollout('conv-second', 130_000), rollout('conv-first', 132_000)]
      expect(CodexIdCapture.matchOf(both, first, [first, second])).toBeNull()
      expect(CodexIdCapture.matchOf(both, second, [first, second])).toBeNull()
    })

    it('claims a rollout the rival window cannot hold', () => {
      const early = [rollout('conv-first', 5_500)]
      expect(CodexIdCapture.matchOf(early, first, [first, second])).toBe('conv-first')
    })

    it('ignores a rival in another directory, a named rival and a refused rival', () => {
      const found = [rollout('conv-second', 130_000)]
      const elsewhere = { ...second, directory: { mode: 'adHoc', path: 'E:\\other' } as const }
      const named = record({ ...second, agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'conv-x' } })
      const refused = { ...second, endedReason: 'the Host said no' }
      expect(CodexIdCapture.matchOf(found, first, [first, elsewhere])).toBe('conv-second')
      expect(CodexIdCapture.matchOf(found, first, [first, named])).toBe('conv-second')
      expect(CodexIdCapture.matchOf(found, first, [first, refused])).toBe('conv-second')
    })

    function prompted(base: SessionRecord, initialPrompt: string): SessionRecord {
      return { ...base, agent: { agentId: 'codex', launchMode: 'new', initialPrompt } }
    }

    // parallel-issue-fixer launches several sessions in one folder, each with its own prompt.
    it('binds both by their prompts whichever rollout lands first', () => {
      const a = prompted(first, 'Fix  ticket #12\n')
      const b = prompted(second, 'Fix ticket #13')
      const bOnly = [rollout('conv-b', 130_000, null, 'Fix ticket #13')]
      expect(CodexIdCapture.matchOf(bOnly, a, [a, b])).toBeNull()
      expect(CodexIdCapture.matchOf(bOnly, b, [a, b])).toBe('conv-b')
      const both = [rollout('conv-b', 130_000, null, 'Fix ticket #13'), rollout('conv-a', 131_000, null, 'Fix ticket #12')]
      expect(CodexIdCapture.matchOf(both, a, [a, b])).toBe('conv-a')
      expect(CodexIdCapture.matchOf(both, b, [a, b])).toBe('conv-b')
    })

    it('leaves both unnamed when they share one prompt', () => {
      const a = prompted(first, 'Same work')
      const b = prompted(second, 'Same work')
      const both = [rollout('conv-b', 130_000, null, 'Same work'), rollout('conv-a', 131_000, null, 'Same work')]
      expect(CodexIdCapture.matchOf(both, a, [a, b])).toBeNull()
      expect(CodexIdCapture.matchOf(both, b, [a, b])).toBeNull()
    })

    it('waits while the rollout has written no first message yet', () => {
      const a = prompted(first, 'Fix ticket #12')
      expect(CodexIdCapture.matchOf([rollout('conv-a', 6_000)], a, [a])).toBeNull()
    })

    it('matches a long prompt by the head the rollout keeps', () => {
      const long = 'x'.repeat(150)
      const a = prompted(first, long)
      expect(CodexIdCapture.matchOf([rollout('conv-a', 6_000, null, long.slice(0, 120))], a, [a]))
        .toBe('conv-a')
      expect(CodexIdCapture.matchOf([rollout('conv-a', 6_000, null, long.slice(0, 20))], a, [a]))
        .toBeNull()
    })

    it('still lets a prompt-less rival block a prompted candidate', () => {
      const a = prompted(first, 'Fix ticket #12')
      const found = [rollout('conv-a', 130_000, null, 'Fix ticket #12')]
      expect(CodexIdCapture.matchOf(found, a, [a, second])).toBeNull()
    })

    it('matches the directory regardless of case and trailing separator', () => {
      const same = { ...second, directory: { mode: 'adHoc', path: 'e:/WORK/bind/' } as const }
      expect(CodexIdCapture.matchOf([rollout('conv-second', 130_000)], first, [first, same]))
        .toBeNull()
    })
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
