import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import { SessionWorkflows } from '../../sessionManager/worktreeSessionRuntime'
import { SvnWaitHelper } from './svnWaitHelper'

describe('lib-orchestrator/sessionManager/lifecycle/svnWaitHelper', () => {
  const worktreeConst = 'Q:/Work/App/.worktrees/014-fix-login'

  function action(overrides?: Partial<SessionRecordSvnAction>): SessionRecordSvnAction {
    return {
      kind: 'finish', actionId: 'a1', stage: 'updating', root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 100, stageAt: 300,
      passes: [{ stage: 'updating', startedAt: 200, endedAt: 300, result: 'done', runId: 'u1' }],
      needs: { kind: 'incoming', reason: 'other commits changed this project: src/a.ts', at: 300 },
      ...overrides,
    }
  }

  function record(overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 's1', kind: 'agent', title: '014 - fix login', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: worktreeConst }, ...overrides,
    }
  }

  it('is offered on every wait of a Finish or a Discard, never while it runs, on an UPDATE or where the merger settles the conflicts', () => {
    expect(SvnWaitHelper.offered(action())).toBe(true)
    expect(SvnWaitHelper.offered(action({ kind: 'discard', needs: { kind: 'not-stopped', reason: 'x', at: 1 } }))).toBe(true)
    expect(SvnWaitHelper.offered(action({ needs: undefined }))).toBe(false)
    expect(SvnWaitHelper.offered(action({ kind: 'update-main', needs: { kind: 'locked', reason: 'x', at: 1 } }))).toBe(false)
    const entry = { path: 'a.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const, options: ['merged' as const], facts: {} }
    const set = { readAt: 1, baseRevision: 1, revision: 2, entries: [entry], more: 0, waited: true as const }
    const conflict = action({ stage: 'fixing', needs: { kind: 'conflict', reason: '1 conflict needs you', at: 5 }, conflictSet: set })
    expect(SvnWaitHelper.offered(conflict)).toBe(false)
    expect(SvnWaitHelper.offered({ ...conflict, conflictSet: { ...set, entries: [{ ...entry, shape: 'binary' as const, options: ['take-incoming' as const] }] } }))
      .toBe(true)
  })

  it('briefs the agent on the wait, the steps and the logs of its runs, the rules, and asks how Jamat could avoid it', () => {
    const current = action()
    const parent = record({ svnAction: current })
    const brief = SvnWaitHelper.briefOf({
      title: parent.title, sessionId: 's1', action: current, need: current.needs!,
      workflow: SessionWorkflows.of(parent, () => null), logOf: (runId) => `L:/logs/s1/${runId}.log`, cli: 'jamat-v3',
      instance: { configIdentity: 'cfg-1', channel: 'development' },
    })
    expect(brief).toContain(`Worktree: \`${worktreeConst}\``)
    expect(brief).toContain('It waits on **incoming**: other commits changed this project: src/a.ts')
    expect(brief).toContain('The person then presses Continue to review.')
    expect(brief).toContain('- svn update: `L:/logs/s1/u1.log`')
    expect(brief).toContain('- [waits] svn update: other commits changed this project: src/a.ts')
    expect(brief).toContain('Never run `svn commit`')
    expect(brief).toContain('`jamat-v3 sessions worktree --session-id s1 --config-identity cfg-1 --channel development`')
    expect(brief).toContain('**How Jamat could avoid this wait**')
  })

  // The helper is a session of its own, so --self names the helper; a call without an instance met two (UA1-J14R-4).
  it('selects this instance in every command line of the brief', () => {
    const current = action({ stage: 'fixing', needs: { kind: 'conflict', reason: '1 conflict needs you', at: 5 } })
    const brief = SvnWaitHelper.briefOf({ title: 'T', sessionId: 's1', action: current, need: current.needs!, workflow: null,
      logOf: () => '', cli: 'jamat-v3', instance: { configIdentity: 'cfg-1', channel: 'production' } })
    const lines = brief.split('\n').filter((line) => line.includes('jamat-v3 sessions '))
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines.filter((line) => !line.includes('Never press')))
      expect(line).toContain('--config-identity cfg-1 --channel production')
    expect(brief).toContain('`jamat-v3 sessions conflicts --session-id s1 --config-identity cfg-1 --channel production`')
  })

  it('forks the Claude worker that ran in the worktree, else starts the worker\'s agent there, as a child of the session', () => {
    const briefFile = 'L:/logs/s1/a1-help.md'
    const claude = record({ agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'n1' }, transcriptCwd: worktreeConst })
    expect(SvnWaitHelper.specOf(claude, { root: worktreeConst, briefFile })).toMatchObject({
      kind: 'agent', directory: { mode: 'adHoc', path: worktreeConst },
      agent: { agentId: 'claude', mode: 'fork', forkParentId: 'n1' }, parent: { sessionId: 's1', kind: 'worker' }, title: 'Solve 014-fix-login',
    })
    const codex = record({ agent: { agentId: 'codex', launchMode: 'new' } })
    const spec = SvnWaitHelper.specOf(codex, { root: worktreeConst, briefFile })
    expect(spec).toMatchObject({ agent: { agentId: 'codex', mode: 'new' }, parent: { sessionId: 's1', kind: 'worker' } })
    expect(spec.agent?.initialPrompt).toContain(briefFile)
    expect(spec.agent?.initialPrompt).not.toContain('\n')
  })
})
