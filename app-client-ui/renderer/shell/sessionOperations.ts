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
import { SessionFolder } from '../sessions/sessionFolder'
import type { TabSessionFacts } from '../widgets/tabs/tabContextMenu'
import type { OpenTerminalPort } from './sessionTabOpener'
import { SessionTabOpener } from './sessionTabOpener'

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
    sessions: SnapshotStore<SessionsSnapshot>,
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
    sessions: SnapshotStore<SessionsSnapshot>,
    sessionId: string,
  ): TabSessionFacts | null {
    const info = sessions.current().snapshot?.sessions
      .find((session) => session.sessionId === sessionId)
    if (info === undefined) return null
    return {
      live: info.life === 'live',
      agentId: info.agent?.agentId ?? null,
      color: info.color ?? null,
      directoryPath: SessionFolder.ofDirectory(info.directory),
      ended: info.life === 'ended' || info.life === 'lost',
      admits: info.admits,
    }
  }

  /**
   * One operation on the target session that answers with a session to show, and the tab for it.
   * A `null` from the call is "there was nothing to ask for", which is not a failure and is silent.
   * The new tab lands where the layout's default puts it, so a target with no panel of its own - a
   * tree row whose session has no open tab here - needs nothing more than its id.
   */
  static async createFrom(
    session: { snapshot: SnapshotStore<SessionsSnapshot>; openTerminal: OpenTerminalPort },
    target: { sessionId: string } | null,
    call: (
      sessionId: string,
      info: SessionInfo,
    ) => Promise<IpcResult<SessionsOpResult<{ sessionId: string; tabTitle: string }>>> | null,
    options: { plain: boolean },
  ): Promise<void> {
    const info = SessionOperations.sessionInfoOf(session.snapshot, target)
    if (info === null) return
    const asked = call(info.sessionId, info)
    if (asked === null) return
    const answer = await asked
    const refusal = IpcFailure.of(answer, 'The session operation')
    if (refusal !== null) {
      AppClientUiReport.error(`${refusal}`)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    const created = answer.value.value
    const failure = await SessionTabOpener.open(
      session.openTerminal,
      created.sessionId,
      created.tabTitle,
      { plain: options.plain, closePlain: (sessionId) => SessionTabOpener.closePlain(sessionId) },
    )
    if (failure !== null) AppClientUiReport.error(`${failure}`)
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
    sessions: SnapshotStore<SessionsSnapshot>,
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
    const answer = await window.appClient.sessions.restart(info.sessionId)
    const refusal = IpcFailure.of(answer, 'Restarting the session')
    if (refusal !== null) {
      AppClientUiReport.error(`${refusal}`)
      return
    }
    // The same path the restart chain uses: every panel holding this session reattaches.
    await window.appClient.tabs.publishTerminalRestarted(info.sessionId)
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
    sessions: SnapshotStore<SessionsSnapshot>,
    target: { sessionId: string } | null,
  ): Promise<void> {
    const info = SessionOperations.sessionInfoOf(sessions, target)
    if (info === null) return
    const path = SessionFolder.ofDirectory(info.directory)
    if (path === null) return
    await SessionOperations.copyPath(path)
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
    const answer = remoteEndpointId === null
      ? await window.appClient.sessions.reference(target.sessionId)
      : await window.appClient.remote.sessionReference(remoteEndpointId, target.sessionId)
    const refusal = IpcFailure.of(answer, 'Copying the session id')
    if (refusal !== null) {
      AppClientUiReport.error(`${refusal}`)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    await SessionOperations.copyText(answer.value.value.text, 'the session id')
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
