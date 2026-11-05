import type { TabControlTaskRef } from '../shared/tabRequestPort.types'
export type { TabControlCommand, TabControlCommandResult, TabControlAck, TabControlTaskRef, TabControlTaskItem } from '../shared/tabRequestPort.types'

export class TabControlTask {
  static keyOf(sessionId: string, task: TabControlTaskRef): string {
    return `task:${sessionId}:${task.kind}:${TabControlTask.idOf(task)}`
  }

  static idOf(task: TabControlTaskRef): string {
    switch (task.kind) {
      case 'subagent': return task.subagentId
      case 'shell': return task.shellId
      case 'script': return task.runId
      default: throw new Error(`Unknown session task: ${JSON.stringify(task satisfies never)}`)
    }
  }
}
