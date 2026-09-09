import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../records/sessionRecord.types'
import { FinalizeSteps } from './finalizeSteps'

describe('lib-orchestrator/sessionManager/lifecycle/finalizeSteps', () => {
  const worktreeConst: SessionRecord['worktree'] = {
    worktreePath: 'Q:/project/.worktrees/fix',
    branch: 'jamat/fix',
    baseCommit: 'abc',
    repositoryRoot: 'Q:/project',
  }

  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'shell',
      title: '001 - fix',
      directory: { mode: 'default' },
      binding: null,
      life: 'live',
      createdAt: 1,
      ...overrides,
    }
  }

  const bindingConst: SessionRecord['binding'] = { hostInstanceId: 'host-1', generation: 1 }

  it('stops a session that is still running, whichever way it has a worktree', () => {
    expect(FinalizeSteps.planOf(record())).toBe('stop')
    expect(FinalizeSteps.planOf(record({ life: 'starting', binding: bindingConst }))).toBe('stop')
    expect(FinalizeSteps.planOf(record({ worktree: worktreeConst }))).toBe('stop')
  })

  /**
   * The shape a launch the Host keeps refusing leaves behind. There is no runtime to stop, so Finish
   * has nothing to do and the row must not offer it - offering it is how such a session ended up
   * with one button whose only possible answer was `has no runtime on the Host yet`.
   */
  it('has nothing to finish for a starting session the Host never took', () => {
    expect(FinalizeSteps.planOf(record({ life: 'starting' }))).toBe('never-started')
    expect(FinalizeSteps.offers(record({ life: 'starting' }))).toBe(false)
    expect(FinalizeSteps.offers(record({ life: 'starting', binding: bindingConst }))).toBe(true)
    // A worktree changes nothing: nothing ran in it, so there is nothing to bring home either.
    expect(FinalizeSteps.planOf(record({ life: 'starting', worktree: worktreeConst })))
      .toBe('never-started')
  })

  // The stop leaves the worktree unfinished on purpose, and this is the step that finishes it.
  it('brings a stopped worktree session home', () => {
    expect(FinalizeSteps.planOf(record({ life: 'ended', worktree: worktreeConst })))
      .toBe('commit-and-merge')
    expect(FinalizeSteps.planOf(record({ life: 'lost', worktree: worktreeConst })))
      .toBe('commit-and-merge')
  })

  /**
   * A dead session with no worktree has nothing left to do, and pressing Finish on one is not an
   * error. Marking it done from here is deliberately not offered: running it again and finishing
   * that run is the way, which is what the tree offers instead.
   */
  it('answers a session with nothing left to do without doing anything', () => {
    expect(FinalizeSteps.planOf(record({ life: 'ended' }))).toBe('already-finalized')
    expect(FinalizeSteps.planOf(record({ life: 'lost' }))).toBe('already-finalized')
    expect(FinalizeSteps.planOf(record({ life: 'ended', completed: true })))
      .toBe('already-finalized')
  })

  /**
   * The agent never ran in that worktree, so the only uncommitted thing in it is what the half-run
   * install left. The row hides the button too, but the rule is here: a caller that is not that row
   * must not be able to ask for it either.
   */
  it('brings nothing home from a session whose install failed', () => {
    expect(FinalizeSteps.planOf(record({
      life: 'ended',
      worktree: worktreeConst,
      pendingSetup: { setupSessionId: 'setup-1' },
    }))).toBe('already-finalized')
  })

  it('throws on a life it does not know', () => {
    expect(() => FinalizeSteps.planOf(record({ life: 'paused' as SessionRecord['life'] })))
      .toThrow(/Unknown session life/)
  })
})
