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
          note: 'throws the branch and the directory away',
          glyph: '✕',
          submitLabel: 'Discard worktree',
          danger: true,
        },
      ],
    })
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

  it('routes Merge and Discard through their narrow ports and rejects any other choice', async () => {
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
    await WorktreeQuestion.spec.perform('discard', ports)
    expect(calls).toEqual(['finalize', 'discardWorktree'])
    expect(() => WorktreeQuestion.spec.perform('keep', ports))
      .toThrow(/Unknown worktree choice/)
  })
})
