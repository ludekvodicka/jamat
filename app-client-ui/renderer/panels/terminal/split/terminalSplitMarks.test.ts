import { describe, expect, it } from 'vitest'

import type { SessionInfo, SessionWorkflowInfo } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { PanelSplitParams, type PanelSplitItem } from '../../../widgets/tabs/panelSplit'
import { TerminalSplitMarks, type TerminalSplitReview } from './terminalSplitMarks'

const commitConst: PanelSplitItem = { kind: 'commit', key: 'draft-1', reviewId: 'draft-1', title: 'Commit SVN', vcs: 'svn', scopeRoot: 'Q:/app' }
const legacyConst: PanelSplitItem = { kind: 'commit', key: PanelSplitParams.commitKeyOf('git', 'Q:/app'), title: 'Commit Git', vcs: 'git', scopeRoot: 'Q:/app' }
const fileConst: PanelSplitItem = { kind: 'file', key: 'file', title: 'a.md', source: { kind: 'workspace', sessionId: 's1', path: 'Q:/app/a.md' } }
const workflowConst = PanelSplitParams.workflowItemOf('s1')

function review(draftId: string, overrides: Partial<TerminalSplitReview> = {}): TerminalSplitReview {
  return { draftId, sessionId: 's1', vcs: 'svn', scopeRoot: 'Q:/app', workflow: false, ...overrides }
}

function sessionWith(state: 'waits' | 'running', open = true): Pick<SessionInfo, 'actions' | 'workflow'> {
  const section = { open, rounds: [{ title: 'Finish', steps: [{ state }] }] } as unknown as SessionWorkflowInfo
  return { actions: { sections: [section] } }
}

describe('app-client-ui/renderer/panels/terminal/split/terminalSplitMarks', () => {
  it('marks the commit item of every pending review of this session, by draft or by its scope key', () => {
    const marks = TerminalSplitMarks.of([commitConst, legacyConst, fileConst], 's1',
      [review('draft-1'), review('draft-2', { vcs: 'git' }), review('draft-3', { sessionId: 's2', scopeRoot: 'Q:/other' })], null)
    expect([...marks]).toEqual([['draft-1', 'Commit review required'], [legacyConst.key, 'Commit review required']])
  })

  it('marks the session actions for a Finish review and for an open step that waits', () => {
    expect([...TerminalSplitMarks.of([workflowConst], 's1', [review('d', { workflow: true })], null)])
      .toEqual([[workflowConst.key, 'Commit review required']])
    expect([...TerminalSplitMarks.of([workflowConst], 's1', [], sessionWith('waits'))]).toEqual([[workflowConst.key, 'Waits for you']])
    expect(TerminalSplitMarks.of([workflowConst], 's1', [], sessionWith('running')).size).toBe(0)
    expect(TerminalSplitMarks.of([workflowConst], 's1', [], sessionWith('waits', false)).size).toBe(0)
  })
})
