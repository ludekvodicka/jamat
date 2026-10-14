import { describe, expect, it } from 'vitest'

import type { SessionScriptRunInfo } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionTaskListing, SessionTaskRow } from '../../../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { TabControlTask } from '../../../../shared/tabControl'
import { ProcessesModel } from './processesModel'

describe('app-client-ui/renderer/panels/terminal/processes/processesModel', () => {
  const agent: SessionTaskRow = {
    kind: 'subagent', subagentId: 'agent', agentType: 'Explore', description: 'Find callers', depth: 1,
    parentSubagentId: null, state: 'done', startedAt: 1_000, endedAt: 4_000, model: null, step: null,
  }
  const shell: SessionTaskRow = {
    kind: 'shell', shellId: 'shell', command: 'pnpm test', description: 'Run tests',
    state: 'running', startedAt: 2_000, endedAt: null,
  }
  const run: SessionScriptRunInfo = {
    runId: 'script', phase: 'inner', scriptId: 'requested', name: 'Build', title: 'Build application',
    state: 'succeeded', summary: 'Build succeeded', startedAt: 1_000, endedAt: 5_000,
    durationText: '4.0 s', commands: [], row: false, log: 'saved',
  }
  const listing: SessionTaskListing = { kind: 'tasks', rows: [agent, shell], catchingUp: false, olderFinished: 0 }

  it('merges tasks and collapsed script history with running first and newest end next', () => {
    const rows = ProcessesModel.rowsOf('session', listing, [run], 'all', null, 10_000)
    expect(rows.map((row) => row.task)).toEqual([
      { kind: 'shell', shellId: 'shell' }, { kind: 'script', runId: 'script' }, { kind: 'subagent', subagentId: 'agent' },
    ])
    expect(rows.map((row) => row.label)).toEqual(['$ pnpm test', 'Build application', 'Explore: Find callers'])
    expect(rows.map((row) => row.time)).toEqual(['8 s', '4.0 s', '3.0 s'])
    expect(rows.map((row) => row.glyph)).toEqual(['●', '✓', '✓'])
  })

  it('keeps running tasks and script runs in Active and hides every finished kind', () => {
    const activeRun = { ...run, runId: 'active-script', state: 'running' as const, endedAt: undefined, durationText: undefined, row: true }
    const rows = ProcessesModel.rowsOf('session', listing, [run, activeRun], 'active', null, 10_000)
    expect(rows.map((row) => row.key)).toEqual(['task:session:shell:shell', 'task:session:script:active-script'])
    expect(rows.every((row) => row.running)).toBe(true)
  })

  it.each([
    { kind: 'subagent', subagentId: 'agent' }, { kind: 'shell', shellId: 'shell' }, { kind: 'script', runId: 'script' },
  ] as const)('marks the selected $kind split item only', (task) => {
    const rows = ProcessesModel.rowsOf('session', listing, [run], 'all', TabControlTask.keyOf('session', task), 10_000)
    expect(rows.filter((row) => row.selected).map((row) => row.task)).toEqual([task])
    expect(ProcessesModel.rowsOf('session', listing, [run], 'all', TabControlTask.keyOf('other', task), 10_000)
      .some((row) => row.selected)).toBe(false)
  })

  it('keeps script history when task discovery has no transcript or has not answered', () => {
    for (const absent of [undefined, { kind: 'none', code: 'transcript-not-found', reason: 'Not found' } as const])
      expect(ProcessesModel.rowsOf('session', absent, [run], 'all', null, 10_000)).toHaveLength(1)
  })

  it('uses start time for unfinished history and omits an unknown duration', () => {
    const unfinished: SessionTaskListing = { ...listing, rows: [{ ...agent, state: 'unfinished', endedAt: null, startedAt: 6_000 }] }
    const rows = ProcessesModel.rowsOf('session', unfinished, [run], 'all', null, 10_000)
    expect(rows[0]).toMatchObject({ task: { kind: 'subagent' }, time: '', glyph: '?', stateLabel: 'Did not finish' })
  })

  it('bounds the title sent to sessionTasks.open without shortening the displayed label', () => {
    const title = 'Build '.repeat(60)
    const rows = ProcessesModel.rowsOf('session', undefined, [{ ...run, title }], 'all', null, 10_000)
    expect(rows[0].label).toBe(title)
    expect(rows[0].title).toHaveLength(200)
  })
})
