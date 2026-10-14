import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  SessionWorkflowAction,
  SessionWorkflowActionId,
  SessionWorkflowTarget,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { ErrorText } from '../../shared/errorText'
import { AppControl } from '../ipc/appControl'
import { IpcFailure } from '../ipc/ipcFailure'
import type { FinalizeAgreement } from '../overlays/finalize/finalizeCatalog'
import { FinalizeAgreements, FinalizeWorking } from '../overlays/finalize/finalizeModel'
import { FinalizePorts } from '../overlays/finalize/finalizeOverlay'
import type { ConflictListPorts } from './conflictList'
import type { WorkflowPorts, WorkflowPressAnswer } from './workflowPane'

/**
 * What the workflow pane of one local session does. A step click opens its process in a further
 * tab, reusing the existing views: a run as the script task of its parent (live output or saved log,
 * Open terminal while it runs), an agent run and the review run in their own tab. A footer press is
 * the Finish press of the dialog with that choice, the row's Retry setup, or the stop of the agent run
 * the press names, and answers the same agreement and still-working refusals.
 */
export class WorkflowPortsOf {
  /** `openInSplit` puts a granted file beside the workflow item and answers a refusal, or null. */
  static of(sessionId: string, report: (sentence: string | null) => void, openInSplit: (document: FileViewerDocument) => string | null): WorkflowPorts {
    return {
      openStep: (target, title) => WorkflowPortsOf.openStep(sessionId, target, title, report),
      press: (action, agreement) => WorkflowPortsOf.press(sessionId, action, agreement),
      conflicts: WorkflowPortsOf.conflictsOf(sessionId, openInSplit),
    }
  }

  /**
   * What a conflict row does: one option through `sessions.resolveConflict` as a window press, which
   * alone may carry the confirmation of a loss; the worktree file in a further inner tab; TortoiseSVN's
   * conflict editor; the merger's brief, which main reads off the session. Main resolves a path inside
   * the session's worktree; each answers the refusal its row shows, or null.
   */
  static conflictsOf(sessionId: string, openInSplit: (document: FileViewerDocument) => string | null): ConflictListPorts {
    return {
      resolve: async (path, option, confirm) => {
        try {
          return IpcFailure.of(await AppControl.sessions('sessions.resolveConflict', {
            session: AppControl.sessionOf(sessionId), path, option, ...confirm ? { confirm: true as const } : {},
          }), 'Settle')
        } catch (thrown: unknown) {
          return `Settle failed: ${ErrorText.of(thrown)}`
        }
      },
      openFile: async (path) => {
        try {
          const answer = await window.appClient.terminalMenu.openConflictFile(sessionId, path)
          if (!answer.ok) return `Open failed: ${answer.error}`
          return answer.value.ok ? openInSplit(answer.value.value) : `Open failed: ${answer.value.detail}`
        } catch (thrown: unknown) {
          return `Open failed: ${ErrorText.of(thrown)}`
        }
      },
      openBrief: async () => {
        try {
          const answer = await window.appClient.terminalMenu.openMergeBrief(sessionId)
          if (!answer.ok) return `Open brief failed: ${answer.error}`
          return answer.value.ok ? openInSplit(answer.value.value) : `Open brief failed: ${answer.value.detail}`
        } catch (thrown: unknown) {
          return `Open brief failed: ${ErrorText.of(thrown)}`
        }
      },
      openConflictEditor: async (path) => {
        try {
          const answer = await window.appClient.terminalMenu.openConflictEditor(sessionId, path)
          if (!answer.ok) return `Edit in TortoiseSVN failed: ${answer.error}`
          return answer.value.ok ? null : answer.value.detail
        } catch (thrown: unknown) {
          return `Edit in TortoiseSVN failed: ${ErrorText.of(thrown)}`
        }
      },
    }
  }

  /** Brings a local session's tab forward with its workflow item active; a failure is only reported. */
  static openWorkflow(sessionId: string): void {
    void AppControl.call('sessionTasks.openWorkflow', { sessionId })
      .then((answer) => {
        if (!answer.ok) AppClientUiReport.error(`The workflow could not be opened: ${answer.error}`)
        else if (!answer.value.ok) AppClientUiReport.error(`The workflow could not be opened: ${answer.value.error.detail}`)
      })
      .catch((error: unknown) => AppClientUiReport.error(`The workflow could not be opened: ${ErrorText.of(error)}`))
  }

  static openStep(sessionId: string, target: SessionWorkflowTarget, title: string, report: (sentence: string | null) => void): void {
    const kind = target.kind
    switch (kind) {
      case 'run':
        WorkflowPortsOf.reported(AppControl.call('sessionTasks.open', { sessionId, task: { kind: 'script', runId: target.runId },
          title: title.slice(0, 200) }), report)
        return
      case 'agent': case 'commit':
        WorkflowPortsOf.reported(AppControl.call('tabs.open', { session: { kind: 'sessionId', sessionId: target.runId } }), report)
        return
      case 'conflicts': case 'none': return
      default: throw new Error(`Unknown workflow target: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  static async press(sessionId: string, action: SessionWorkflowAction, agreement: FinalizeAgreement): Promise<WorkflowPressAnswer> {
    if (action.id === 'open-in-vscode') return WorkflowPortsOf.openInVsCode(sessionId)
    if (action.id === 'open-merger') return WorkflowPortsOf.openMerger(action)
    let answer: Awaited<ReturnType<ReturnType<typeof FinalizePorts.of>['finishWorktree']>>
    try {
      answer = await WorkflowPortsOf.sent(sessionId, action, agreement)
    } catch (thrown: unknown) {
      return { kind: 'refused', sentence: ErrorText.of(thrown) }
    }
    const setup = FinalizeAgreements.of(answer)
    if (setup !== null) return { kind: 'agreement', setup }
    const working = FinalizeWorking.of(answer)
    if (working !== null) return { kind: 'working', sentence: working }
    const failure = IpcFailure.of(answer, WorkflowPortsOf.labelOf(action.id))
    return failure === null ? { kind: 'done' } : { kind: 'refused', sentence: failure }
  }

  /**
   * Finish again (Check again), Keep worktree and Discard are the Finish press with that choice;
   * Resolve with agent is Commit with `agent`; Retry setup is the row's retry; Stop agent stops the
   * agent run it names, and the action then reads what it left.
   */
  private static sent(sessionId: string, action: SessionWorkflowAction, agreement: FinalizeAgreement)
    : ReturnType<ReturnType<typeof FinalizePorts.of>['finishWorktree']> {
    const finish = FinalizePorts.of({ kind: 'local', sessionId })
    const id = action.id
    switch (id) {
      case 'finish-again': return finish.finishWorktree('commit', agreement)
      case 'keep': return finish.finishWorktree('keep', agreement)
      case 'discard': return finish.finishWorktree('discard', agreement)
      case 'resolve-with-agent': return AppControl.sessionsDone('sessions.finishWorktree', {
        session: AppControl.sessionOf(sessionId),
        choice: 'commit',
        agent: true,
        ...(agreement.acknowledgeSetup === undefined ? {} : { acknowledgeSetup: agreement.acknowledgeSetup }),
        ...(agreement.confirmWorking === true ? { confirmWorking: true } : {}),
      })
      case 'retry-setup': return AppControl.sessionsDone('sessions.retrySetup', {
        session: AppControl.sessionOf(sessionId),
        ...(agreement.acknowledgeSetup === undefined ? {} : { acknowledgeSetup: agreement.acknowledgeSetup }),
      })
      case 'stop-agent': {
        if (action.runId === undefined) throw new Error('A Stop agent press names no agent run')
        return AppControl.sessionsDone('sessions.finalize', { session: AppControl.sessionOf(action.runId), expect: 'stop' })
      }
      case 'open-in-vscode': case 'open-merger': throw new Error(`${WorkflowPortsOf.labelOf(id)} is no operation of the Finish`)
      default: throw new Error(`Unknown workflow action: ${JSON.stringify(id satisfies never)}`)
    }
  }

  /** The merger's tab, where the person talks to it, as a click on its step opens it. */
  private static async openMerger(action: SessionWorkflowAction): Promise<WorkflowPressAnswer> {
    if (action.runId === undefined) throw new Error('An Open merger press names no agent run')
    try {
      const answer = await AppControl.call('tabs.open', { session: { kind: 'sessionId', sessionId: action.runId } })
      if (!answer.ok) return { kind: 'refused', sentence: `Open merger failed: ${answer.error}` }
      return answer.value.ok ? { kind: 'done' } : { kind: 'refused', sentence: `Open merger failed: ${answer.value.error.detail}` }
    } catch (thrown: unknown) {
      return { kind: 'refused', sentence: `Open merger failed: ${ErrorText.of(thrown)}` }
    }
  }

  /** The worktree in VS Code, read off the session by main, as the row menu opens it. */
  private static async openInVsCode(sessionId: string): Promise<WorkflowPressAnswer> {
    try {
      const answer = await window.appClient.terminalMenu.openProjectVsCode(sessionId)
      if (!answer.ok) return { kind: 'refused', sentence: `Open in VS Code failed: ${answer.error}` }
      return answer.value ? { kind: 'done' } : { kind: 'refused', sentence: `Open in VS Code failed: no session ${sessionId}` }
    } catch (thrown: unknown) {
      return { kind: 'refused', sentence: `Open in VS Code failed: ${ErrorText.of(thrown)}` }
    }
  }

  private static labelOf(action: SessionWorkflowActionId): string {
    switch (action) {
      case 'finish-again': return 'Finish again'
      case 'keep': return 'Keep worktree'
      case 'discard': return 'Discard'
      case 'retry-setup': return 'Retry setup'
      case 'stop-agent': return 'Stop agent'
      case 'open-in-vscode': return 'Open in VS Code'
      case 'resolve-with-agent': return 'Resolve with agent'
      case 'open-merger': return 'Open merger'
      default: throw new Error(`Unknown workflow action: ${JSON.stringify(action satisfies never)}`)
    }
  }

  private static reported(
    call: Promise<IpcResult<RemoteControlStepResult<unknown>>>,
    report: (sentence: string | null) => void,
  ): void {
    void call.then(
      (answer) => report(!answer.ok ? answer.error : !answer.value.ok ? answer.value.error.detail : null),
      (thrown: unknown) => report(ErrorText.of(thrown)),
    )
  }
}
