import { CommitPaneBridge, CommitPaneChannel } from '../versioning/commitPanePorts'
import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  SessionWorkflowAction,
  SessionWorkflowTarget,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppControlRequest } from '../../shared/appOperationMap'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { ErrorText } from '../../shared/errorText'
import { AppControl } from '../ipc/appControl'
import { IpcFailure } from '../ipc/ipcFailure'
import type { FinalizeAgreement } from '../overlays/finalize/finalizeCatalog'
import { FinalizeAgreements, FinalizeWorking } from '../overlays/finalize/finalizeModel'
import { FinalizePorts } from '../overlays/finalize/finalizeOverlay'
import type { ConflictListPorts } from './conflictList'
import type { WorkflowPorts, WorkflowPressAnswer, WorkflowCommit } from './workflowPane'

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
      requestRun: async (command, cwd) => IpcFailure.of(await AppControl.sessions('sessions.runScript', {
        session: AppControl.sessionOf(sessionId), command, cwd, title: 'Worktree validation',
      }), 'Start validation run'),
      clearHistory: async () => IpcFailure.of(await AppControl.sessions('sessions.clearActions', { session: AppControl.sessionOf(sessionId) }), 'Clear'),
      reviews: CommitPaneBridge.of(),
      tasks: {
        openTerminal: async (runId) => {
          const answer = await AppControl.call('tabs.open', { session: { kind: 'sessionId', sessionId: runId } })
          return !answer.ok ? answer.error : !answer.value.ok ? answer.value.error.detail : null
        },
        scriptOutput: (request) => AppControl.call('sessions.scriptOutput', request),
        transcript: (request) => AppControl.call('sessionTasks.transcript', request),
        shellOutput: (request) => AppControl.call('sessionTasks.shellOutput', request),
      },
      openStep: (target, title) => WorkflowPortsOf.openStep(sessionId, target, title, report),
      press: (action, agreement, commit) => WorkflowPortsOf.press(sessionId, action, agreement, commit),
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
      resolve: async (path, option, confirm, kind) => {
        try {
          return IpcFailure.sentenceOf(await AppControl.sessions('sessions.resolveConflict', {
            session: AppControl.sessionOf(sessionId), path, ...kind === undefined ? {} : { kind }, option, ...confirm ? { confirm: true as const } : {},
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

  static async press(sessionId: string, action: SessionWorkflowAction, agreement: FinalizeAgreement, commit?: WorkflowCommit): Promise<WorkflowPressAnswer> {
    if (commit?.reviewed) {
      if (action.id !== 'finish-again' || !action.requiresCommit) return { kind: 'refused', sentence: 'This action no longer accepts a commit review' }
      const decide = window.appClient.versioning.decideCommit
      if (!decide) return { kind: 'refused', sentence: 'This client cannot approve a shared Finish review' }
      return WorkflowPortsOf.reviewResult(await decide({ ...commit.reviewed.proof, kind: 'finish', operationId: crypto.randomUUID(),
        workflow: { workflowId: commit.reviewed.workflowId, revision: commit.reviewed.revision, actionId: 'finish-again', agreement, acknowledgedFindings: commit.acknowledgedFindings, repositories: commit.repositories,
          ...commit.reviewVersion === undefined ? {} : { reviewVersion: commit.reviewVersion } } }))
    }
    if (action.id === 'later') return { kind: 'done' }
    if (action.id === 'open-in-vscode') return WorkflowPortsOf.openInVsCode(sessionId)
    if (action.id === 'open-merger') return WorkflowPortsOf.openMerger(action)
    if (action.id === 'resume-worker') return WorkflowPortsOf.resumeWorker(sessionId, action.label)
    let answer: Awaited<ReturnType<ReturnType<typeof FinalizePorts.of>['finishWorktree']>>
    try {
      answer = await WorkflowPortsOf.sent(sessionId, action, agreement, commit)
    } catch (thrown: unknown) {
      return { kind: 'refused', sentence: ErrorText.of(thrown) }
    }
    const setup = FinalizeAgreements.of(answer)
    if (setup !== null) return { kind: 'agreement', setup }
    const working = FinalizeWorking.of(answer)
    if (working !== null) return { kind: 'working', sentence: working }
    // The step redraws the current list with the refusal, so the person only has to look and press again.
    if (IpcFailure.codeOf(answer) === 'live-sessions') return { kind: 'refused', sentence: WorkflowPortsOf.liveSessionsChangedConst }
    const failure = IpcFailure.sentenceOf(answer, action.label)
    return failure === null ? { kind: 'done' } : { kind: 'refused', sentence: failure }
  }

  static readonly liveSessionsChangedConst = 'The sessions in the main copy changed. Check the list and press Update again.'

  static reviewResult(answer: IpcResult<import('../../shared/versioningCommit').VersioningCommitRunResult>): WorkflowPressAnswer {
    const lost = CommitPaneChannel.lossOf(answer)
    if (lost !== null) return { kind: 'refused', sentence: CommitPaneChannel.unansweredOf(lost) }
    if (!answer.ok) return { kind: 'refused', sentence: answer.error }
    if (answer.value.ok) return { kind: 'done' }
    if (answer.value.setup) return { kind: 'agreement', setup: answer.value.setup }
    if (answer.value.working) return { kind: 'working', sentence: answer.value.detail }
    return { kind: 'refused', sentence: answer.value.detail }
  }

  /**
   * Finish again (Check again), Keep worktree and Discard are the Finish press with that choice;
   * Resolve with agent is Commit with `agent`; Solve with agent is an operation of its own; Retry setup is the row's retry; Stop agent stops the
   * agent run it names, and the action then reads what it left.
   */
  private static sent(sessionId: string, action: SessionWorkflowAction, agreement: FinalizeAgreement, commit?: WorkflowCommit)
    : ReturnType<ReturnType<typeof FinalizePorts.of>['finishWorktree']> {
    const command = action.command
    if (command === undefined) throw new Error(`${action.label} has no source operation`)
    return AppControl.sessionsDone(command.operation, {
      session: AppControl.sessionOf(command.sessionId ?? sessionId), ...agreement, ...commit, ...command.body,
    } as AppControlRequest<typeof command.operation>)
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

  /** The row's Resume session: the reopen, then every panel that holds the session reattaches. */
  private static async resumeWorker(sessionId: string, label: string): Promise<WorkflowPressAnswer> {
    try {
      const refusal = IpcFailure.sentenceOf(await AppControl.sessionsDone('sessions.reopen', { session: AppControl.sessionOf(sessionId) }), label)
      if (refusal !== null) return { kind: 'refused', sentence: refusal }
      const published = await window.appClient.tabs.publishTerminalRestarted(sessionId)
      return published.ok ? { kind: 'done' } : { kind: 'refused', sentence: `${label}: the terminal restart was not published: ${published.error}` }
    } catch (thrown: unknown) {
      return { kind: 'refused', sentence: `${label} failed: ${ErrorText.of(thrown)}` }
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
