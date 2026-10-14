import { describe, expect, it } from 'vitest'

import type {
  SessionInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import type { SessionFinalizePorts } from './finalizeCatalog'
import { FinalizeAsks, type FinalizeScope } from './finalizeModel'
import { WorktreeQuestion } from './worktreeQuestion'

function sessionOf(sessions: readonly SessionInfo[], sessionId: string): SessionInfo {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId)
  if (session === undefined) throw new Error(`Missing test session: ${sessionId}`)
  return session
}

describe('app-client-ui/renderer/overlays/finalize/worktreeQuestion', () => {
  it('offers Merge, Keep and danger Discard locally, defaulting to Merge', () => {
    const session = sessionOf(SessionsFixtures.stoppedWorktree().sessions, 's-dirty')

    expect(WorktreeQuestion.spec.questionOf(session, 'local')).toEqual({
      label: 'Worktree',
      chosenDefault: 'merge',
      startsWorkflow: ['merge'],
      choices: [
        {
          id: 'merge',
          title: 'Merge back',
          note: "commits anything uncommitted, merges into jamat/dirty's base and removes the worktree",
          glyph: '⇤',
          submitLabel: 'Merge',
        },
        {
          id: 'keep',
          title: 'Keep worktree',
          note: 'decide later; the row keeps Finish…',
          glyph: '—',
          submitLabel: null,
        },
        {
          id: 'discard',
          title: 'Discard worktree',
          note: 'throws the branch, the directory and its unmeasured changes away',
          glyph: '✕',
          submitLabel: 'Discard worktree',
          danger: true,
        },
      ],
    })
  })

  it('renders the choices the library composed for an SVN worktree, defaulting to Commit', () => {
    const session = sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-svn')
    const question = WorktreeQuestion.spec.questionOf(session, 'local')

    expect(question?.choices.map((choice) => choice.id)).toEqual(['commit', 'keep', 'discard'])
    expect(question?.chosenDefault).toBe('commit')
    expect(question?.choices[0]).toMatchObject({ title: 'Commit', submitLabel: 'Commit' })
    expect(question?.choices.find((choice) => choice.id === 'discard')).toMatchObject({
      note: 'throws the checkout and its 2 changed files away',
      danger: true,
    })
  })

  it('offers only Keep and Discard for a legacy store-cut worktree, whatever its kind', () => {
    const session = sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-store-cut')
    const question = WorktreeQuestion.spec.questionOf(session, 'local')

    expect(question?.choices.map((choice) => choice.id)).toEqual(['keep', 'discard'])
    expect(question?.chosenDefault).toBe('keep')
  })

  it('takes the choices off the snapshot rather than off the kind', () => {
    const svn = sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-svn')
    if (svn.worktree === undefined) throw new Error('The SVN fixture lost its worktree')
    const reordered = { ...svn, worktree: { ...svn.worktree, choices: ['keep', 'discard'] as const } }

    expect(WorktreeQuestion.spec.questionOf(reordered, 'local')?.choices.map((choice) => choice.id))
      .toEqual(['keep', 'discard'])
  })

  it('names the automatic removal, not Keep, when the cleanup after the end owns the worktree, and only closes', () => {
    const svn = sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-svn')
    if (svn.worktree === undefined) throw new Error('The SVN fixture lost its worktree')
    const summary = 'removed once the session has ended and nothing is left in it'
    const automatic = {
      ...svn,
      worktree: { ...svn.worktree, choices: ['keep', 'discard'] as const, cleanup: { phase: 'pending' as const, summary } },
    }
    const question = WorktreeQuestion.spec.questionOf(automatic, 'local')

    expect(question?.chosenDefault).toBe('keep')
    expect(question?.choices[0]).toEqual({ id: 'keep', title: 'Remove automatically', note: summary, glyph: '↻', submitLabel: null })
    if (question === null || question === undefined) throw new Error('The question went missing')
    const ask = { target: { kind: 'local' as const, sessionId: svn.sessionId }, scope: 'local' as const, sessionTitle: svn.title,
      session: { glyph: 'ended' as const, group: 'Sessions', note: null }, questions: [{ specId: 'worktree', question }] }
    expect(FinalizeAsks.submitLabelOf(ask, new Map())).toBe('Close')

    // A worktree the cleanup kept for its changes is the person's again.
    const kept = { ...svn, worktree: { ...svn.worktree, cleanup: { phase: 'kept' as const, reason: '2 changes', summary: 'kept: 2 changes' } } }
    expect(WorktreeQuestion.spec.questionOf(kept, 'local')?.choices.find((choice) => choice.id === 'keep')?.title)
      .toBe('Keep worktree')
  })

  it('asks nothing while a finish holds the session', () => {
    const reviewing = sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-reviewing')
    expect(WorktreeQuestion.spec.questionOf(reviewing, 'local')).toBeNull()
  })

  it('throws on a finish choice it does not know', () => {
    const svn = sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-svn')
    if (svn.worktree === undefined) throw new Error('The SVN fixture lost its worktree')
    const unknown = { ...svn, worktree: { ...svn.worktree, choices: ['rebase'] as never } }

    expect(() => WorktreeQuestion.spec.questionOf(unknown, 'local')).toThrow('Unknown finish choice')
  })

  it('omits Discard remotely and omits a discard-only question altogether', () => {
    const stopped = sessionOf(SessionsFixtures.stoppedWorktree().sessions, 's-dirty')
    expect(WorktreeQuestion.spec.questionOf(stopped, 'remote')?.choices.map((choice) => choice.id))
      .toEqual(['merge', 'keep'])

    const failed = sessionOf(SessionsFixtures.setupOutcomes().sessions, 's-failed')
    expect(WorktreeQuestion.spec.questionOf(failed, 'remote')).toBeNull()
  })

  it('makes Keep the safe default when Discard is the only admitted operation', () => {
    const failed = sessionOf(SessionsFixtures.setupOutcomes().sessions, 's-failed')
    const question = WorktreeQuestion.spec.questionOf(failed, 'local')

    expect(question?.choices.map((choice) => choice.id)).toEqual(['keep', 'discard'])
    expect(question?.chosenDefault).toBe('keep')
    expect(question?.choices.find((choice) => choice.id === 'discard')?.danger).toBe(true)
  })

  it('does not ask for a missing worktree or a worktree whose session is still live', () => {
    const mixed = SessionsFixtures.mixed().sessions
    expect(WorktreeQuestion.spec.questionOf(sessionOf(mixed, 's-ended'), 'local')).toBeNull()
    expect(WorktreeQuestion.spec.questionOf(sessionOf(mixed, 's-working'), 'local')).toBeNull()
  })

  it('throws on a finalize scope it does not know', () => {
    const session = sessionOf(SessionsFixtures.stoppedWorktree().sessions, 's-dirty')
    const scope = 'elsewhere' as unknown as FinalizeScope

    expect(() => WorktreeQuestion.spec.questionOf(session, scope))
      .toThrow('Unknown finalize scope')
  })

  it('routes Commit, Keep and Discard through the Finish press with the agreement, Merge through finalize, and rejects any other choice', async () => {
    const calls: string[] = []
    const ports: SessionFinalizePorts = {
      finalize: (acknowledgeSetup) => {
        calls.push(acknowledgeSetup === undefined ? 'finalize' : `finalize ${acknowledgeSetup}`)
        return Promise.resolve({ ok: true, value: { ok: true, value: undefined } })
      },
      finishWorktree: (choice, agreement) => {
        calls.push(`finishWorktree ${choice}${agreement.acknowledgeSetup === undefined ? '' : ` ${agreement.acknowledgeSetup}`}${
          agreement.confirmWorking === true ? ' confirmed' : ''}`)
        return Promise.resolve({ ok: true, value: { ok: true, value: undefined } })
      },
    }

    await WorktreeQuestion.spec.perform('merge', ports, {})
    await WorktreeQuestion.spec.perform('commit', ports, {})
    await WorktreeQuestion.spec.perform('discard', ports, {})
    await WorktreeQuestion.spec.perform('keep', ports, {})
    await WorktreeQuestion.spec.perform('merge', ports, { acknowledgeSetup: 'hash-1' })
    await WorktreeQuestion.spec.perform('commit', ports, { acknowledgeSetup: 'hash-2', confirmWorking: true })
    expect(calls).toEqual(['finalize', 'finishWorktree commit', 'finishWorktree discard', 'finishWorktree keep', 'finalize hash-1',
      'finishWorktree commit hash-2 confirmed'])
    expect(() => WorktreeQuestion.spec.perform('rebase', ports, {}))
      .toThrow(/Unknown worktree choice/)
  })

  describe('an SVN worktree whose session runs or whose Finish waits', () => {
    const svn = (): SessionInfo => sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-svn')

    it('asks a running SVN session on this computer, whose action stops it first; never on a peer', () => {
      const base = svn()
      if (base.worktree === undefined) throw new Error('The SVN fixture lost its worktree')
      const live: SessionInfo = { ...base, life: 'live', admits: ['newBeside', 'finalize'], worktree: { ...base.worktree, liveFinish: true } }

      const question = WorktreeQuestion.spec.questionOf(live, 'local')
      expect(question?.choices.map((choice) => choice.id)).toEqual(['commit', 'keep', 'discard'])
      expect(question?.choices[0]?.note).toMatch(/^stops the session, runs the checks/)
      expect(WorktreeQuestion.spec.questionOf(live, 'remote')).toBeNull()
      const { liveFinish: _liveFinish, ...plain } = live.worktree!
      expect(WorktreeQuestion.spec.questionOf({ ...live, worktree: plain }, 'local')).toBeNull()
    })

    it('asks nothing on this computer while an action runs or waits; a peer keeps Commit for a waiting one', () => {
      const waiting: SessionInfo = {
        ...svn(),
        svnAction: { kind: 'finish', stage: 'reviewing', needs: 'the review ended without a commit', needsKind: 'review-cancelled', review: null },
      }
      expect(WorktreeQuestion.spec.questionOf(waiting, 'local')).toBeNull()
      const remote = WorktreeQuestion.spec.questionOf(waiting, 'remote')
      expect(remote?.choices.filter((choice) => choice.submitLabel !== null).map((choice) => choice.id)).toEqual(['commit'])
      expect(remote?.startsWorkflow).toBeUndefined()

      const running: SessionInfo = { ...waiting, svnAction: { ...waiting.svnAction!, needs: null, needsKind: null } }
      expect(WorktreeQuestion.spec.questionOf(running, 'local')).toBeNull()
      expect(WorktreeQuestion.spec.questionOf(running, 'remote')).toBeNull()
    })

    it('names Commit and Discard of an SVN worktree and Merge back of a Git one as the presses that start a workflow', () => {
      expect(WorktreeQuestion.spec.questionOf(svn(), 'local')?.startsWorkflow).toEqual(['commit', 'discard'])
      const git = sessionOf(SessionsFixtures.stoppedWorktree().sessions, 's-dirty')
      expect(WorktreeQuestion.spec.questionOf(git, 'local')?.startsWorkflow).toEqual(['merge'])
      expect(WorktreeQuestion.spec.questionOf(git, 'remote')?.startsWorkflow).toBeUndefined()
    })
  })
})
