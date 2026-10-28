import { describe, expect, it } from 'vitest'

import type { SessionInfo, SessionSvnActionInfo, SessionWorkflowInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { FinishAttention, type FinishAttentionNotice } from './finishAttention'

describe('app-client-ui/app/sessions/finishAttention', () => {
  const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
    sessionId, kind: 'agent', title: `${sessionId} title`, tabTitle: sessionId, life: 'ended', activity: null, admits: [],
    directory: { mode: 'default' }, ...extra,
  } as SessionInfo)
  const action = (extra: Partial<SessionSvnActionInfo>): SessionSvnActionInfo => ({
    kind: 'finish', stage: 'fixing', needs: null, needsKind: null, review: null, ...extra,
  })
  const workflow = (waitingKey: string): SessionWorkflowInfo => ({
    kind: 'finish', workflowId: 'a1', title: 'Finish', badge: 'conflicts need you', summary: 'Waits for you: 2 conflicts need you', open: true,
    rounds: [{ title: 'Finish', steps: [{ key: waitingKey, title: 'Check the conflicts', detail: '', state: 'waits', startedAt: 1, endedAt: 2,
      target: { kind: 'conflicts' } }] }],
    actions: [],
  })
  const waiting = (reason: string, key = '1:fixing'): SessionInfo => session('s1', {
    svnAction: action({ needs: reason, needsKind: 'conflict', summary: '2 conflicts need you' }), workflow: workflow(key),
  })
  const attention = (): { shown: FinishAttentionNotice[]; it: FinishAttention } => {
    const shown: FinishAttentionNotice[] = []
    return { shown, it: new FinishAttention({ show: (notice) => shown.push(notice) }) }
  }
  const snapshot = (sessions: SessionInfo[], reconciled = true) => ({ reconciled, sessions })

  it('shows nothing for a wait the first reconciled snapshot holds, and one notice for a new wait', () => {
    const { shown, it: told } = attention()
    told.seen(snapshot([waiting('2 conflicts need you')], false))
    told.seen(snapshot([waiting('2 conflicts need you')]))
    expect(shown).toEqual([])

    told.seen(snapshot([waiting('2 conflicts need you'), session('s2', { svnAction: action({ needs: 'the check tests failed', needsKind: 'check-failed' }) })]))
    expect(shown).toEqual([{ sessionId: 's2', title: 'Finish waits: s2 title', body: 'the check tests failed' }])
  })

  it('shows the same wait once, not for a reason a settlement rewrote, and again for a new wait after Check again', () => {
    const { shown, it: told } = attention()
    told.seen(snapshot([]))
    told.seen(snapshot([waiting('2 conflicts need you')]))
    told.seen(snapshot([waiting('2 conflicts need you')]))
    told.seen(snapshot([waiting('2 conflicts: you fixed 1, 1 needs you')]))
    expect(shown).toEqual([{ sessionId: 's1', title: 'Finish waits: s1 title', body: '2 conflicts need you' }])

    told.seen(snapshot([waiting('1 conflict needs you', '1:fixing#2')]))
    expect(shown).toHaveLength(2)
  })

  it('says when the merger waits for an answer, from the activity of its run', () => {
    const { shown, it: told } = attention()
    const merging = (activity: SessionInfo['activity']) => [
      session('s1', { svnAction: action({ stage: 'merging', mergerRunId: 'm1' }) }),
      session('m1', { activity }),
    ]
    told.seen(snapshot(merging('working')))
    told.seen(snapshot(merging('waiting')))
    expect(shown).toEqual([{ sessionId: 's1', title: 'The merger of s1 title waits for you', body: 'It asks for an answer in its tab.' }])
    told.seen(snapshot(merging('working')))
    told.seen(snapshot(merging('waiting')))
    expect(shown).toHaveLength(2)
  })

  it('notifies once per authoritative review wait even when the review version changes', () => {
    const { shown, it: told } = attention()
    told.seen(snapshot([]))
    const view = { version: 7, phase: 'waiting' as const, step: 'reviewing' as const, outOfDate: 0, conflicts: 0,
      wait: { kind: 'waiting-for-review' as const, at: 1234, reason: 'Open Session actions' }, summary: 'Waiting for review' }
    told.seen(snapshot([session('s1', { worktreeView: view })]))
    told.seen(snapshot([session('s1', { worktreeView: { ...view, version: 8 } })]))
    expect(shown).toEqual([{ sessionId: 's1', title: 'Finish waits: s1 title', body: 'Open Session actions' }])
  })

  it('tells nothing for an UPDATE of a main copy or a running action', () => {
    const { shown, it: told } = attention()
    told.seen(snapshot([]))
    told.seen(snapshot([session('s1', { svnAction: action({ kind: 'update-main', needs: 'locked', needsKind: 'locked' }) }),
      session('s2', { svnAction: action({ stage: 'updating' }) })]))
    expect(shown).toEqual([])
  })
})
