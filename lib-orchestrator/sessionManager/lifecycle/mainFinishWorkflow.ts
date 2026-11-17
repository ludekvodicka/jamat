import type { SessionRecord, SessionRecordMainFinish } from '../records/sessionRecord.types'
import type { SessionMainFinishChoice, SessionWorkflowAction, SessionWorkflowActionId, SessionWorkflowInfo, SessionWorkflowStep } from '../sessionManagerApi.types'

/** The Session actions section of a main-copy Finish, composed from its record alone. */
export class MainFinishWorkflow {
  static readonly pathsLimitConst = 200

  static of(record: SessionRecord): SessionWorkflowInfo | null {
    const finish = record.mainFinish
    if (finish === undefined) return null
    const phase = finish.phase
    const count = finish.paths.length + finish.more
    const files = `${count} changed ${count === 1 ? 'file' : 'files'}${finish.vcs === null ? '' : ` (${MainFinishWorkflow.vcsNameOf(finish.vcs)})`}`
    const steps: SessionWorkflowStep[] = [{ key: 'changes', title: 'Changes of this session', detail: files,
      state: phase === 'choosing' ? 'waits' : 'done', startedAt: finish.startedAt,
      endedAt: phase === 'choosing' ? null : finish.sentAt ?? finish.endedAt ?? null, target: { kind: 'none' },
      body: { kind: 'files', paths: finish.paths, more: finish.more } }]
    if (finish.sentAt !== undefined)
      steps.push({ key: 'commit', title: 'Commit in the session', detail: finish.command ?? '',
        state: phase === 'committing' ? 'running' : 'done', startedAt: finish.sentAt,
        endedAt: phase === 'committing' ? null : finish.endedAt ?? null, target: { kind: 'none' } })
    if (phase === 'closed' && finish.result === 'closed')
      steps.push({ key: 'close', title: 'Close session', detail: '', state: 'done',
        startedAt: finish.endedAt ?? null, endedAt: finish.endedAt ?? null, target: { kind: 'none' } })
    return { kind: 'main-finish', workflowId: `main-finish:${record.sessionId}:${finish.startedAt}`, title: `Finish of ${record.title}`,
      badge: MainFinishWorkflow.badgeOf(finish), summary: MainFinishWorkflow.summaryOf(finish, files),
      open: phase !== 'closed', startedAt: finish.startedAt, ...finish.endedAt === undefined ? {} : { endedAt: finish.endedAt },
      rounds: [{ title: 'Finish', steps }], actions: MainFinishWorkflow.actionsOf(finish) }
  }

  private static actionsOf(finish: SessionRecordMainFinish): SessionWorkflowAction[] {
    const phase = finish.phase
    switch (phase) {
      case 'choosing': return [
        ...finish.vcs === null ? [] : [
          MainFinishWorkflow.press('commit-close', 'Commit & close', 'commit-close', true),
          MainFinishWorkflow.press('commit-continue', 'Commit & continue', 'commit-continue', false)],
        { ...MainFinishWorkflow.press('close-session', 'Close session', 'close', finish.vcs === null),
          confirm: 'Close the session without a commit? Its changes stay in the working copy.' },
        MainFinishWorkflow.press('cancel-finish', 'Back to work', 'cancel', false, false),
      ]
      case 'committing': return [{ ...MainFinishWorkflow.press('cancel-finish', 'Keep the session', 'cancel', false, false),
        note: 'The commit goes on; Jamat no longer closes the session.' }]
      case 'closed': return []
      default: throw new Error(`Unknown main Finish phase: ${JSON.stringify(phase satisfies never)}`)
    }
  }

  private static press(id: SessionWorkflowActionId, label: string, choice: SessionMainFinishChoice, primary: boolean, atStep = true): SessionWorkflowAction {
    return { id, label, primary, ...atStep ? { place: 'step' as const } : {}, command: { operation: 'sessions.finishMain', body: { mainChoice: choice } } }
  }

  private static badgeOf(finish: SessionRecordMainFinish): string {
    const phase = finish.phase
    switch (phase) {
      case 'choosing': return 'changes to commit'
      case 'committing': return 'committing'
      case 'closed': return MainFinishWorkflow.resultWordOf(finish.result)
      default: throw new Error(`Unknown main Finish phase: ${JSON.stringify(phase satisfies never)}`)
    }
  }

  private static summaryOf(finish: SessionRecordMainFinish, files: string): string {
    const phase = finish.phase
    switch (phase) {
      case 'choosing': return finish.note ?? (finish.vcs === null ? `This session has ${files}.`
        : `This session has ${files}. Commit them through the session's agent, or close the session.`)
      case 'committing': return 'The session commits its changes. Jamat closes it when its turn ends and none of its changes remain.'
      case 'closed': {
        const result = finish.result
        switch (result) {
          case 'closed': return finish.sentAt === undefined ? 'Session closed without a commit.' : 'Changes committed. Session closed.'
          case 'sent': return `Commit command sent: ${finish.command ?? ''}. The session goes on.`
          case 'cancelled': return finish.sentAt === undefined ? 'Finish left. The session goes on.' : 'The session goes on; Jamat does not close it.'
          case 'ended': return finish.note ?? 'The session ended before its commit was done.'
          case undefined: return 'Finish ended'
          default: throw new Error(`Unknown main Finish result: ${JSON.stringify(result satisfies never)}`)
        }
      }
      default: throw new Error(`Unknown main Finish phase: ${JSON.stringify(phase satisfies never)}`)
    }
  }

  private static resultWordOf(result: SessionRecordMainFinish['result']): string {
    switch (result) {
      case 'closed': return 'closed'
      case 'sent': return 'commit sent'
      case 'cancelled': return 'left'
      case 'ended': return 'ended'
      case undefined: return 'ended'
      default: throw new Error(`Unknown main Finish result: ${JSON.stringify(result satisfies never)}`)
    }
  }

  private static vcsNameOf(vcs: 'svn' | 'git'): string {
    switch (vcs) {
      case 'svn': return 'SVN'
      case 'git': return 'Git'
      default: throw new Error(`Unknown VCS: ${JSON.stringify(vcs satisfies never)}`)
    }
  }
}
