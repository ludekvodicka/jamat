import type { SessionScriptRunInfo } from '../sessionManager/sessionManagerApi.types'
import type { TabControlTaskRef } from '../shared/tabRequestPort.types'
import type { SessionTaskRow } from './sessionTasksApi.types'

export type SessionProcessKind = 'service' | 'requested' | 'shell' | 'subagent'

export interface SessionProcess {
  task: TabControlTaskRef
  kind: SessionProcessKind
  running: boolean
  /** An inner run whose own record still exists (`SessionScriptRunInfo.row`); a task row: false. */
  row: boolean
  startedAt: number
  endedAt: number | null
}

/** `more`: how many the `and N more…` row stands for; 0: no such row. */
export interface SessionProcessesShown {
  shown: readonly SessionProcess[]
  more: number
}

export class SessionProcesses {
  static readonly treeRowsMaxConst = 3

  /** Inner runs and task rows, running first, then newest. A setup or a Finish check is never a process. */
  static listOf(runs: readonly SessionScriptRunInfo[], rows: readonly SessionTaskRow[]): SessionProcess[] {
    const list: SessionProcess[] = []
    for (const run of runs) {
      const phase = run.phase
      if (phase === 'before' || phase === 'after') continue
      else if (phase !== 'inner') throw new Error(`Unknown script phase: ${JSON.stringify(phase satisfies never)}`)
      const kind = run.scriptId
      if (kind !== 'service' && kind !== 'requested') throw new Error(`Unknown inner run: ${JSON.stringify(kind)}`)
      list.push({
        task: { kind: 'script', runId: run.runId },
        kind,
        running: run.state === 'running',
        row: run.row,
        startedAt: run.startedAt,
        endedAt: run.endedAt ?? null,
      })
    }
    for (const row of rows)
      switch (row.kind) {
        case 'shell':
          list.push({
            task: { kind: 'shell', shellId: row.shellId },
            kind: 'shell',
            running: row.state === 'running',
            row: false,
            startedAt: row.startedAt,
            endedAt: row.endedAt ?? null,
          })
          break
        case 'subagent':
          list.push({
            task: { kind: 'subagent', subagentId: row.subagentId },
            kind: 'subagent',
            running: row.state === 'running',
            row: false,
            startedAt: row.startedAt,
            endedAt: row.endedAt ?? null,
          })
          break
        default:
          throw new Error(`Unknown session task row: ${JSON.stringify(row satisfies never)}`)
      }
    return list.sort((left, right) => Number(right.running) - Number(left.running) || right.startedAt - left.startedAt)
  }

  static shownOf(list: readonly SessionProcess[], max = SessionProcesses.treeRowsMaxConst): SessionProcessesShown {
    return list.length <= max
      ? { shown: list, more: 0 }
      : { shown: list.slice(0, max - 1), more: list.length - (max - 1) }
  }
}
