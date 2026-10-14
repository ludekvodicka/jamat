import type { SessionScriptRunInfo } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ScriptDuration } from '../../../../../lib-orchestrator/sessionManager/scripts/scriptDuration'
import type { SessionTaskListing, SessionTaskRow } from '../../../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { TabControlTask, type TabControlTaskRef } from '../../../../shared/tabControl'
import { SessionNodeState, type SessionPaint } from '../../../views/sessionsTree/sessionNodeState'
import { SessionTaskGlyphs } from '../../../views/sessionsTree/sessionTaskRows'

export type ProcessesFilter = 'all' | 'active'

export interface ProcessRow {
  key: string
  task: TabControlTaskRef
  label: string
  title: string
  detail: string
  running: boolean
  startedAt: number
  endedAt: number | null
  glyph: string
  paint: SessionPaint
  stateLabel: string
  time: string
  selected: boolean
}

export class ProcessesModel {
  static rowsOf(
    sessionId: string,
    listing: SessionTaskListing | undefined,
    runs: readonly SessionScriptRunInfo[],
    filter: ProcessesFilter,
    selectedKey: string | null,
    now: number,
  ): readonly ProcessRow[] {
    const tasks = ProcessesModel.tasksOf(listing).map((task) => ProcessesModel.taskRow(sessionId, task, now))
    const rows = [...tasks, ...runs.map((run) => ProcessesModel.scriptRow(sessionId, run, now))]
      .map((row) => ({ ...row, selected: row.key === selectedKey }))
      .sort((left, right) => Number(right.running) - Number(left.running)
        || (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt)
        || left.key.localeCompare(right.key))
    switch (filter) {
      case 'all': return rows
      case 'active': return rows.filter((row) => row.running)
      default: throw new Error(`Unknown processes filter: ${JSON.stringify(filter satisfies never)}`)
    }
  }

  private static tasksOf(listing: SessionTaskListing | undefined): readonly SessionTaskRow[] {
    if (listing === undefined) return []
    switch (listing.kind) {
      case 'none': return []
      case 'tasks': return listing.rows
      default: throw new Error(`Unknown task listing: ${JSON.stringify(listing satisfies never)}`)
    }
  }

  private static taskRow(sessionId: string, row: SessionTaskRow, now: number): ProcessRow {
    let task: TabControlTaskRef
    let label: string
    let detail: string
    switch (row.kind) {
      case 'subagent':
        task = { kind: 'subagent', subagentId: row.subagentId }
        label = `${row.agentType}: ${row.description}`
        detail = row.step ?? row.description
        break
      case 'shell':
        task = { kind: 'shell', shellId: row.shellId }
        label = `$ ${row.command}`
        detail = row.description ?? row.command
        break
      default: throw new Error(`Unknown process: ${JSON.stringify(row satisfies never)}`)
    }
    return {
      key: TabControlTask.keyOf(sessionId, task), task, label, title: label.slice(0, 200), detail,
      running: row.state === 'running', startedAt: row.startedAt, endedAt: row.endedAt,
      glyph: SessionTaskGlyphs.characterOf(row.state), paint: SessionTaskGlyphs.paintOf(row.state),
      stateLabel: SessionTaskGlyphs.titleOf(row.state),
      time: ProcessesModel.durationOf(row.startedAt, row.endedAt, row.state === 'running', now),
      selected: false,
    }
  }

  private static scriptRow(sessionId: string, run: SessionScriptRunInfo, now: number): ProcessRow {
    const task: TabControlTaskRef = { kind: 'script', runId: run.runId }
    return {
      key: TabControlTask.keyOf(sessionId, task), task, label: run.title, title: run.title.slice(0, 200),
      detail: run.summary, running: run.state === 'running', startedAt: run.startedAt, endedAt: run.endedAt ?? null,
      glyph: SessionNodeState.runCharacterOf(run.state), paint: SessionNodeState.runPaintOf(run.state),
      stateLabel: run.state,
      time: run.durationText ?? ProcessesModel.durationOf(run.startedAt, run.endedAt ?? null, run.state === 'running', now),
      selected: false,
    }
  }

  private static durationOf(startedAt: number, endedAt: number | null, running: boolean, now: number): string {
    if (running) return ScriptDuration.elapsedText(now - startedAt)
    return endedAt === null ? '' : ScriptDuration.text(endedAt - startedAt)
  }
}
