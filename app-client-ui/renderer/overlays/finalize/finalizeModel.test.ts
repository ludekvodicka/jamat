import { describe, expect, it } from 'vitest'

import type {
  SessionInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import {
  FinalizeCatalog,
  type SessionFinalizeQuestionSpec,
} from './finalizeCatalog'
import { FinalizeAgreements, FinalizeAsks } from './finalizeModel'

function sessionOf(sessions: readonly SessionInfo[], sessionId: string): SessionInfo {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId)
  if (session === undefined) throw new Error(`Missing test session: ${sessionId}`)
  return session
}

function specOf(id: string, order: number): SessionFinalizeQuestionSpec {
  return {
    id,
    order,
    questionOf: () => ({
      label: id,
      choices: [{ id: 'do', title: id, note: null, glyph: id, submitLabel: id }],
      chosenDefault: 'do',
    }),
    perform: (_choiceId, ports) => ports.finalize(),
  }
}

describe('app-client-ui/renderer/overlays/finalize/finalizeModel', () => {
  it('builds one captured ask from the applicable catalog questions', () => {
    const session = sessionOf(SessionsFixtures.stoppedWorktree().sessions, 's-dirty')
    const target = { kind: 'local' as const, sessionId: session.sessionId }
    const ask = FinalizeAsks.of(session, target, 'local', 'Sessions')

    expect(ask).toMatchObject({
      target,
      scope: 'local',
      sessionTitle: 'Dirty worktree',
      questions: [{ specId: 'worktree' }],
    })
  })

  it('carries the activity and note from the snapshot and the group label the opener names', () => {
    const base = sessionOf(SessionsFixtures.svnWorktrees().sessions, 's-svn')
    if (base.worktree === undefined) throw new Error('The SVN worktree fixture has no worktree')
    const live: SessionInfo = {
      ...base,
      life: 'live',
      activity: 'working',
      note: 'ready for review soon',
      worktree: { ...base.worktree, liveFinish: true },
    }
    const target = { kind: 'local' as const, sessionId: live.sessionId }

    expect(FinalizeAsks.of(live, target, 'local', 'Automation')?.session)
      .toEqual({ glyph: 'working', group: 'Automation', note: 'ready for review soon' })
    expect(FinalizeAsks.of({ ...live, activity: 'waiting', note: undefined }, target, 'local', 'None')?.session)
      .toEqual({ glyph: 'waiting', group: 'None', note: null })
  })

  it('offers a Finish exactly when it builds an ask', () => {
    const svn = SessionsFixtures.svnWorktrees().sessions
    const mixed = SessionsFixtures.mixed().sessions
    for (const session of [...svn, ...mixed])
      expect(FinalizeAsks.offered(session, 'local'))
        .toBe(FinalizeAsks.of(session, { kind: 'local', sessionId: session.sessionId }, 'local', 'Sessions') !== null)
  })

  it('returns null without an applicable question', () => {
    const mixed = SessionsFixtures.mixed().sessions
    expect(FinalizeAsks.of(
      sessionOf(mixed, 's-ended'),
      { kind: 'local', sessionId: 's-ended' },
      'local',
      'Sessions',
    )).toBeNull()
    expect(FinalizeAsks.of(
      sessionOf(mixed, 's-working'),
      { kind: 'local', sessionId: 's-working' },
      'local',
      'Sessions',
    )).toBeNull()
    expect(FinalizeAsks.of(
      sessionOf(mixed, 's-tab'),
      { kind: 'local', sessionId: 's-tab' },
      'local',
      'Sessions',
    )).toBeNull()
  })

  it('accepts a sorted injected catalog without teaching the model its entries', () => {
    const session = sessionOf(SessionsFixtures.mixed().sessions, 's-ended')
    const catalog = FinalizeCatalog.questions([specOf('second', 2), specOf('first', 1)])
    const ask = FinalizeAsks.of(
      session,
      { kind: 'local', sessionId: session.sessionId },
      'local',
      'Sessions',
      catalog,
    )

    expect(ask?.questions.map((entry) => entry.specId)).toEqual(['first', 'second'])
  })

  it('refuses duplicate ids and orders in an injected catalog', () => {
    expect(() => FinalizeCatalog.questions([specOf('same', 1), specOf('same', 2)]))
      .toThrow(/Two finalize questions claim the same id/)
    expect(() => FinalizeCatalog.questions([specOf('one', 1), specOf('two', 1)]))
      .toThrow(/Two finalize questions claim the same order/)
  })

  it('answers the selected action verb, Close for no-op selections, and Finish for several verbs', () => {
    const session = sessionOf(SessionsFixtures.stoppedWorktree().sessions, 's-dirty')
    const target = { kind: 'local' as const, sessionId: session.sessionId }
    const ask = FinalizeAsks.of(session, target, 'local', 'Sessions')
    if (ask === null) throw new Error('The worktree ask was not built')

    expect(FinalizeAsks.submitLabelOf(ask, new Map([['worktree', 'merge']]))).toBe('Merge')
    expect(FinalizeAsks.submitLabelOf(ask, new Map([['worktree', 'keep']]))).toBe('Close')

    const two = FinalizeAsks.of(
      session,
      target,
      'local',
      'Sessions',
      FinalizeCatalog.questions([specOf('first', 1), specOf('second', 2)]),
    )
    if (two === null) throw new Error('The injected ask was not built')
    expect(FinalizeAsks.submitLabelOf(two, new Map())).toBe('Finish')
  })

  it('refuses a selected choice the question does not hold', () => {
    const session = sessionOf(SessionsFixtures.stoppedWorktree().sessions, 's-dirty')
    const ask = FinalizeAsks.of(
      session,
      { kind: 'local', sessionId: session.sessionId },
      'local',
      'Sessions',
    )
    if (ask === null) throw new Error('The worktree ask was not built')

    expect(() => FinalizeAsks.submitLabelOf(ask, new Map([['worktree', 'missing']])))
      .toThrow(/Unknown finalize choice/)
  })

  it('answers the registered question by id and refuses an unknown id', () => {
    expect(FinalizeCatalog.byId('worktree').id).toBe('worktree')
    expect(() => FinalizeCatalog.byId('missing')).toThrow(/Unknown finalize question/)
  })

  it('reads an agreement from a local and a remote refusal, and only a well-formed one', () => {
    const setup = { commands: ['pnpm install'], hash: 'hash-1' }
    const detail = 'asks to run 1 command'
    expect(FinalizeAgreements.of({ ok: true, value: { ok: false, code: 'setup-not-acknowledged', detail, setup } }))
      .toEqual(setup)
    expect(FinalizeAgreements.of({ ok: true, value: { ok: false, code: 'merge-pending', detail, setup } })).toBeNull()
    expect(FinalizeAgreements.of({ ok: true, value: { ok: true, value: undefined } })).toBeNull()
    expect(FinalizeAgreements.of({ ok: false, error: 'closed' })).toBeNull()
    const remote = (data: Record<string, unknown>) => FinalizeAgreements.of({
      ok: true,
      value: {
        protocol: 'appjamat-v3-control.v1',
        requestId: 'request-1',
        operation: 'sessions.finalize',
        operationId: null,
        ok: false,
        error: { code: 'operation-failed', detail, data },
      },
    })
    expect(remote({ sourceCode: 'setup-not-acknowledged', setup })).toEqual(setup)
    expect(remote({ sourceCode: 'svn-failed', setup })).toBeNull()
    expect(remote({ sourceCode: 'setup-not-acknowledged', setup: { commands: [7], hash: 'hash-1' } })).toBeNull()
    expect(remote({ sourceCode: 'setup-not-acknowledged', setup: { commands: [] } })).toBeNull()
  })
})
