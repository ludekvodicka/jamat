import { describe, expect, it } from 'vitest'

import type {
  SessionInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import type { SessionFinalizePorts } from './finalizeCatalog'
import type { FinalizeScope } from './finalizeModel'
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

  it('routes Merge, Commit and Discard through their narrow ports and rejects any other choice', async () => {
    const calls: string[] = []
    const ports: SessionFinalizePorts = {
      finalize: () => {
        calls.push('finalize')
        return Promise.resolve({ ok: true, value: { ok: true, value: undefined } })
      },
      discardWorktree: () => {
        calls.push('discardWorktree')
        return Promise.resolve({ ok: true, value: { ok: true, value: undefined } })
      },
    }

    await WorktreeQuestion.spec.perform('merge', ports)
    await WorktreeQuestion.spec.perform('commit', ports)
    await WorktreeQuestion.spec.perform('discard', ports)
    expect(calls).toEqual(['finalize', 'finalize', 'discardWorktree'])
    expect(() => WorktreeQuestion.spec.perform('keep', ports))
      .toThrow(/Unknown worktree choice/)
  })
})
