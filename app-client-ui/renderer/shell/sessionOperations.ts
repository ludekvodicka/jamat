import type {
  SessionInfo,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { FileChangesVcsId } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { IpcFailure } from '../ipc/ipcFailure'
import type { SessionCompact } from '../contextCompaction/sessionCompact'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { FinalizeAsks } from '../overlays/finalize/finalizeModel'
import { SessionFolder } from '../sessions/sessionFolder'
import type { TabSessionFacts } from '../widgets/tabs/tabContextMenu'
import { SessionTabOpener, type OpenTerminalPort } from './sessionTabOpener'
import { AppControl } from '../ipc/appControl'

/**
 * What the commands DO to a session, once something has decided which session they are about.
 *
 * Away from the shell's composition, which registered them: every one of these takes the session it
 * acts on and the one collaborator it needs, and none of them knows anything about panels, dockview
 * or the window it is running in. Reporting is the shared rule - a command handler starts work and
 * does not wait for it, so a refusal has no caller left to raise it to.
 */
export class SessionOperations {
  /**
   * What the target is a session of, out of the snapshot every workspace already reads. Null where
   * there is no target, or where the snapshot has not arrived or no longer names it: a menu item
   * that acted on a guess would be worse than one that does nothing.
   */
  static sessionInfoOf(
    sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current'>,
    target: { sessionId: string } | null,
  ): SessionInfo | null {
    if (target === null) return null
    return sessions.current().snapshot?.sessions
      .find((session) => session.sessionId === target.sessionId) ?? null
  }

  /**
   * What the tab's menu is drawn from. Read when the menu opens rather than subscribed to: a menu
   * lives for a moment, and a snapshot arriving under an open one would move the items being
   * pointed at.
   */
  static sessionFactsOf(
    sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current'>,
    sessionId: string,
  ): TabSessionFacts | null {
    const info = sessions.current().snapshot?.sessions
      .find((session) => session.sessionId === sessionId)
    if (info === undefined) return null
    return {
      live: info.life === 'live',
      agentId: info.agent?.agentId ?? null,
      ...(info.agent?.accountId ? { accountId: info.agent.accountId } : {}),
      color: info.color ?? null,
      directoryPath: SessionFolder.ofDirectory(info.directory),
      ended: info.life === 'ended' || info.life === 'lost',
      admits: info.admits,
      // UI01 is about worktree sessions; any other row's Finish arms a second click on the row itself.
      finish: info.worktree !== undefined && FinalizeAsks.rowActionsOf(info, 'local').includes('finalize'),
    }
  }

  /** An operation on the target session that shows nothing new, so there is no tab to open. */
  static async onSession(
    target: { sessionId: string } | null,
    call: (sessionId: string) => Promise<IpcResult<SessionsOpResult>>,
  ): Promise<void> {
    if (target === null) return
    const refusal = IpcFailure.of(await call(target.sessionId), 'The session operation')
    if (refusal !== null) AppClientUiReport.error(`${refusal}`)
  }

  /**
   * Restarting asks first while something is running, because the answer being thrown away is work
   * somebody is waiting on. The question is a client's to ask - the operation itself just acts.
   */
  static async restartSession(
    sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current'>,
    target: { sessionId: string } | null,
  ): Promise<void> {
    const info = SessionOperations.sessionInfoOf(sessions, target)
    if (info === null) return
    if (info.life === 'live') {
      const asked = await window.appClient.dialog.confirm(
        'Restart this session?',
        'The process running now will be stopped, and the conversation resumed in a new one.',
      )
      if (!asked.ok || !asked.value) return
    }
    const answer = await AppControl.sessionsDone('sessions.restart', { session: AppControl.sessionOf(info.sessionId) })
    const refusal = IpcFailure.of(answer, 'Restarting the session')
    if (refusal !== null) {
      AppClientUiReport.error(`${refusal}`)
      return
    }
    // The same path the restart chain uses: every panel holding this session reattaches.
    await window.appClient.tabs.publishTerminalRestarted(info.sessionId)
  }

  static async resumeSession(
    sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current'>,
    target: { sessionId: string } | null,
    openTerminal: OpenTerminalPort,
  ): Promise<void> {
    const info = SessionOperations.sessionInfoOf(sessions, target)
    if (info === null) return
    const answer = await AppControl.sessionsDone('sessions.reopen', { session: AppControl.sessionOf(info.sessionId) })
    const refusal = IpcFailure.of(answer, 'Resuming the session')
    if (refusal !== null) {
      AppClientUiReport.error(refusal)
      return
    }
    // Existing panels must reattach before opening or focusing this session's terminal.
    const published = await window.appClient.tabs.publishTerminalRestarted(info.sessionId)
    if (!published.ok) AppClientUiReport.error(`terminal restart not published: ${published.error}`)
    const failure = await SessionTabOpener.open(openTerminal, info.sessionId, info.tabTitle)
    if (failure !== null) AppClientUiReport.error(failure)
  }

  /** Typed into the session's terminal in this window, exactly as a person would type it. */
  static compactSession(
    compact: SessionCompact,
    target: { sessionId: string } | null,
  ): void {
    if (target === null) return
    compact.manual(target.sessionId)
  }

  static async commitSession(sessions: SnapshotStore<SessionsSnapshot>, target: { sessionId: string } | null,
    vcs: FileChangesVcsId): Promise<void> {
    const info = SessionOperations.sessionInfoOf(sessions, target)
    if (info?.life !== 'live') return
    const answer = await window.appClient.versioning.openCommitTab(info.sessionId, vcs)
    const refusal = IpcFailure.of(answer, 'Opening commit dialog')
    if (refusal !== null) AppClientUiReport.error(refusal)
  }

  static async copyProjectFolder(
    sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current'>,
    target: { sessionId: string } | null,
  ): Promise<void> {
    const info = SessionOperations.sessionInfoOf(sessions, target)
    if (info === null) return
    const path = SessionFolder.ofDirectory(info.directory)
    if (path === null) return
    await SessionOperations.copyPath(path)
  }

  /** The main process reads the project root off the session; the renderer names no path. */
  static async openInVsCode(target: { sessionId: string } | null): Promise<void> {
    if (target === null) return
    const answer = await window.appClient.terminalMenu.openProjectVsCode(target.sessionId)
    if (!answer.ok) AppClientUiReport.error(`Opening VS Code failed: ${answer.error}`)
    else if (!answer.value) AppClientUiReport.error(`Opening VS Code failed: no session ${target.sessionId}`)
  }

  /**
   * One session written down for a SECOND agent - the machine, the agent's own conversation id, the
   * directory and the transcript. The text is composed in the library, here and on the paired
   * computer's row alike; what this decides is only which side is asked.
   */
  static async copySessionReference(
    target: { sessionId: string } | null,
    remoteEndpointId: string | null,
  ): Promise<void> {
    if (target === null) return
    const reference = await SessionOperations.sessionReferenceText(target.sessionId, remoteEndpointId, 'Copying the session id')
    if (reference.kind === 'refused') AppClientUiReport.error(reference.detail)
    else if (reference.kind === 'text') await SessionOperations.copyText(reference.text, 'the session id')
    else throw new Error(`Unknown session reference answer: ${JSON.stringify(reference)}`)
  }

  /** The text the copy above writes, also pasted by a terminal a session row was dropped on. */
  static async sessionReferenceText(
    sessionId: string,
    remoteEndpointId: string | null,
    label: string,
  ): Promise<{ kind: 'text'; text: string } | { kind: 'refused'; detail: string }> {
    const answer = remoteEndpointId === null
      ? await AppControl.sessions('sessions.reference', { session: AppControl.sessionOf(sessionId) })
      : await window.appClient.remote.sessionReference(remoteEndpointId, sessionId)
    const refusal = IpcFailure.of(answer, label)
    if (refusal !== null) return { kind: 'refused', detail: refusal }
    if (!answer.ok || !answer.value.ok) throw new Error(`${label}: a refusal without a reason`)
    return { kind: 'text', text: answer.value.value.text }
  }

  /** The write itself, shared by the session's folder and the project row's. */
  static async copyPath(path: string): Promise<void> {
    await SessionOperations.copyText(path, 'the project folder')
  }

  /**
   * The clipboard write both of the above end in. `what` names the thing that did not land: a
   * clipboard another process holds open fails silently in Chromium, so the sentence is all anybody
   * gets to tell the two copies apart.
   */
  private static async copyText(text: string, what: string): Promise<void> {
    const written = await window.appClient.clipboard.writeText(text)
    if (!written.ok) AppClientUiReport.error(`Copying ${what} failed: ${written.error}`)
  }
}
