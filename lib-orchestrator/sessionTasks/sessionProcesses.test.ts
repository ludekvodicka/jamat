import { describe, expect, it } from 'vitest'

import type { SessionScriptRunInfo } from '../sessionManager/sessionManagerApi.types'
import type { SessionShellRow, SessionSubagentRow, SessionTaskRow } from './sessionTasksApi.types'
import { SessionProcesses } from './sessionProcesses'

describe('lib-orchestrator/sessionTasks/sessionProcesses', () => {
  function run(over: Partial<SessionScriptRunInfo> & Pick<SessionScriptRunInfo, 'runId' | 'startedAt'>): SessionScriptRunInfo {
    return {
      phase: 'inner',
      scriptId: 'requested',
      name: over.runId,
      title: over.runId,
      commands: [],
      state: 'running',
      row: true,
      summary: over.runId,
      log: 'none',
      ...over,
    }
  }

  function shell(over: Partial<SessionShellRow> & Pick<SessionShellRow, 'shellId' | 'startedAt'>): SessionShellRow {
    return {
      kind: 'shell',
      command: 'echo hi',
      description: null,
      state: 'running',
      endedAt: null,
      ...over,
    }
  }

  function subagent(over: Partial<SessionSubagentRow> & Pick<SessionSubagentRow, 'subagentId' | 'startedAt'>): SessionSubagentRow {
    return {
      kind: 'subagent',
      agentType: 'Explore',
      description: 'Inspect',
      depth: 1,
      parentSubagentId: null,
      state: 'running',
      endedAt: null,
      model: null,
      step: null,
      ...over,
    }
  }

  it('orders running items first, then newest first, across all four kinds', () => {
    const list = SessionProcesses.listOf(
      [
        run({ runId: 'svc-old', scriptId: 'service', startedAt: 100, state: 'running', row: true }),
        run({ runId: 'req-done', scriptId: 'requested', startedAt: 500, endedAt: 600, state: 'failed', row: true }),
        run({ runId: 'req-new', scriptId: 'requested', startedAt: 300, state: 'running', row: true }),
        run({ runId: 'svc-done', scriptId: 'service', startedAt: 200, endedAt: 250, state: 'stopped', row: false }),
      ],
      [
        shell({ shellId: 'sh-run', startedAt: 400, state: 'running' }),
        shell({ shellId: 'sh-done', startedAt: 700, endedAt: 800, state: 'done' }),
        subagent({ subagentId: 'ag-run', startedAt: 200, state: 'running' }),
        subagent({ subagentId: 'ag-done', startedAt: 600, endedAt: 650, state: 'done' }),
      ],
    )

    expect(list.map((item) => [item.kind, item.running, item.startedAt, item.task])).toEqual([
      ['shell', true, 400, { kind: 'shell', shellId: 'sh-run' }],
      ['requested', true, 300, { kind: 'script', runId: 'req-new' }],
      ['subagent', true, 200, { kind: 'subagent', subagentId: 'ag-run' }],
      ['service', true, 100, { kind: 'script', runId: 'svc-old' }],
      ['shell', false, 700, { kind: 'shell', shellId: 'sh-done' }],
      ['subagent', false, 600, { kind: 'subagent', subagentId: 'ag-done' }],
      ['requested', false, 500, { kind: 'script', runId: 'req-done' }],
      ['service', false, 200, { kind: 'script', runId: 'svc-done' }],
    ])
  })

  it('excludes before and after script runs', () => {
    const list = SessionProcesses.listOf([
      run({ runId: 'before-1', phase: 'before', scriptId: 'setup', startedAt: 100 }),
      run({ runId: 'after-1', phase: 'after', scriptId: 'checks', startedAt: 200 }),
      run({ runId: 'inner-1', phase: 'inner', scriptId: 'service', startedAt: 300 }),
    ], [])

    expect(list.map((item) => item.task)).toEqual([{ kind: 'script', runId: 'inner-1' }])
  })

  it('applies the three-row limit and counts overflow processes', () => {
    const make = (count: number) => SessionProcesses.listOf(
      Array.from({ length: count }, (_, index) => run({ runId: `r-${index}`, startedAt: index + 1 })),
      [],
    )

    const three = SessionProcesses.shownOf(make(3))
    expect(three.shown).toHaveLength(3)
    expect(three.more).toBe(0)

    const four = SessionProcesses.shownOf(make(4))
    expect(four.shown).toHaveLength(2)
    expect(four.more).toBe(2)

    const ten = SessionProcesses.shownOf(make(10))
    expect(ten.shown).toHaveLength(2)
    expect(ten.more).toBe(8)
  })

  it('carries row from run info for inner runs and sets row false for shell and sub-agent rows', () => {
    const list = SessionProcesses.listOf(
      [
        run({ runId: 'r-with-row', scriptId: 'requested', startedAt: 300, row: true }),
        run({ runId: 'r-history', scriptId: 'service', startedAt: 200, endedAt: 250, state: 'stopped', row: false }),
      ],
      [
        shell({ shellId: 'sh-1', startedAt: 100 }),
        subagent({ subagentId: 'ag-1', startedAt: 50 }),
      ],
    )

    expect(list.map((item) => [item.kind, item.row, item.endedAt])).toEqual([
      ['requested', true, null],
      ['shell', false, null],
      ['subagent', false, null],
      ['service', false, 250],
    ])
  })

  it('throws on an unknown inner script id, phase or task row kind', () => {
    expect(() => SessionProcesses.listOf([
      run({ runId: 'bad', phase: 'inner', scriptId: 'setup', startedAt: 1 }),
    ], [])).toThrow('Unknown inner run: "setup"')

    expect(() => SessionProcesses.listOf([
      run({ runId: 'bad-phase', phase: 'during' as never, scriptId: 'requested', startedAt: 1 }),
    ], [])).toThrow('Unknown script phase: "during"')

    expect(() => SessionProcesses.listOf([], [
      { kind: 'worker' } as unknown as SessionTaskRow,
    ])).toThrow('Unknown session task row')
  })
})
