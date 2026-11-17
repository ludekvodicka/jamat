import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordMainFinish } from '../records/sessionRecord.types'
import { MainFinishWorkflow } from './mainFinishWorkflow'
import { SessionWorkflows } from './sessionWorkflows'

describe('lib-orchestrator/sessionManager/lifecycle/mainFinishWorkflow', () => {
  function record(mainFinish?: SessionRecordMainFinish): SessionRecord {
    return { sessionId: 's1', kind: 'agent', title: '007 - plan', createdAt: 0, life: 'live', binding: null,
      directory: { mode: 'adHoc', path: 'Q:/proj' }, ...mainFinish === undefined ? {} : { mainFinish } }
  }
  const choosing: SessionRecordMainFinish = { startedAt: 10, phase: 'choosing', vcs: 'svn', paths: ['app/a.ts'], more: 2 }

  it('draws nothing for a session that never pressed Finish', () => {
    expect(MainFinishWorkflow.of(record())).toBeNull()
  })

  it('waits at the changes with the four presses, each a finishMain command', () => {
    const section = MainFinishWorkflow.of(record(choosing))!
    expect(section).toMatchObject({ kind: 'main-finish', workflowId: 'main-finish:s1:10', title: 'Finish of 007 - plan',
      badge: 'changes to commit', open: true, startedAt: 10 })
    expect(section.summary).toBe("This session has 3 changed files (SVN). Commit them through the session's agent, or close the session.")
    expect(section.rounds[0]!.steps).toEqual([{ key: 'changes', title: 'Changes of this session', detail: '3 changed files (SVN)',
      state: 'waits', startedAt: 10, endedAt: null, target: { kind: 'none' }, body: { kind: 'files', paths: ['app/a.ts'], more: 2 } }])
    expect(section.actions.map((action) => [action.id, action.label, action.primary, action.command?.body.mainChoice]))
      .toEqual([['commit-close', 'Commit & close', true, 'commit-close'], ['commit-continue', 'Commit & continue', false, 'commit-continue'],
        ['close-session', 'Close session', false, 'close'], ['cancel-finish', 'Back to work', false, 'cancel']])
    expect(section.actions.every((action) => action.command?.operation === 'sessions.finishMain')).toBe(true)
    expect(section.actions.find((action) => action.id === 'close-session')?.confirm).toBeDefined()
  })

  it('offers only Close session and Back to work when no VCS was read', () => {
    const section = MainFinishWorkflow.of(record({ ...choosing, vcs: null, paths: [], more: 0, note: 'The changes could not be read' }))!
    expect(section.actions.map((action) => action.id)).toEqual(['close-session', 'cancel-finish'])
    expect(section.actions[0]!.primary).toBe(true)
    expect(section.summary).toBe('The changes could not be read')
  })

  it('runs the commit step while the agent commits, with Keep the session as the way out', () => {
    const section = MainFinishWorkflow.of(record({ ...choosing, phase: 'committing', command: '/commit-svn', sentAt: 20 }))!
    expect(section.badge).toBe('committing')
    expect(section.rounds[0]!.steps.map((step) => [step.key, step.state, step.detail])).toEqual([['changes', 'done', '3 changed files (SVN)'],
      ['commit', 'running', '/commit-svn']])
    expect(section.actions.map((action) => action.id)).toEqual(['cancel-finish'])
  })

  it('closes with no presses once the session was closed after its commit', () => {
    const section = MainFinishWorkflow.of(record({ ...choosing, phase: 'closed', command: '/commit-svn', sentAt: 20, endedAt: 30, result: 'closed' }))!
    expect(section).toMatchObject({ open: false, badge: 'closed', summary: 'Changes committed. Session closed.', endedAt: 30, actions: [] })
    expect(section.rounds[0]!.steps.map((step) => [step.key, step.state])).toEqual([['changes', 'done'], ['commit', 'done'], ['close', 'done']])
  })

  it('is the last section of Session actions and goes with Clear once closed', () => {
    const closed = record({ ...choosing, phase: 'closed', endedAt: 30, result: 'cancelled' })
    expect(SessionWorkflows.sectionsOf(closed, () => null).map((section) => section.workflowId)).toEqual(['main-finish:s1:10'])
    expect(SessionWorkflows.sectionsOf({ ...closed, clearedWorkflowIds: ['main-finish:s1:10'] }, () => null)).toEqual([])
  })
})
