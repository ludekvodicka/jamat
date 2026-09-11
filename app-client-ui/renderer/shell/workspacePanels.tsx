import type {
  FileViewerDocumentSource,
  FileViewerLocation,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import type { TabControlCommand, TabControlCommandResult } from '../../shared/tabControl'
import { PanelKeysConst } from '../../shared/tabTransfer'
import { type TerminalTarget, TerminalTargetCodec } from '../../shared/terminalTarget'
import { ErrorText } from '../../shared/errorText'
import type { FileViewerBaselineHint } from '../fileViewer/fileViewerPanel.types'
import { IpcFailure } from '../ipc/ipcFailure'
import type { SnapshotStore } from '../ipc/snapshotStore'
import type { SessionOpenIntent } from '../views/sessionsTree/sessionsTreeView'
import { TabsController } from '../widgets/tabs/tabsController'
import { PanelSplitParams } from '../widgets/tabs/panelSplit'
import type { ActiveTerminalReading } from './activeTerminalStore'
import type { PanelOpenOutcome } from './appShell.types'

/**
 * The panels of one workspace: opening them, finding the one a command is about, and the tab
 * control the main process drives them with.
 *
 * Away from the shell's composition, which was the reason that class could not be described without
 * an "and": it wired the workspace AND registered the commands AND did all of this. Everything here
 * takes the controller it acts on; nothing here knows how the workspace was assembled.
 */
export class WorkspacePanels {
  static readonly probeTitleConst = 'Lifecycle Probe'
  /** Per document, so two probes in one window are told apart by their titles. */
  private static probeIndex = 0

  static openFileViewer(
    controller: TabsController,
    source: FileViewerDocumentSource,
    documentKey: string,
    baselineHint?: FileViewerBaselineHint,
    location?: FileViewerLocation,
  ): Promise<PanelOpenOutcome> {
    const title = WorkspacePanels.leafOf(source.path, 'File')
    const params = {
      sessionId: source.sessionId,
      source,
      ...(baselineHint === undefined ? {} : { baselineHint }),
      ...(location === undefined ? {} : { location }),
    }
    return controller.openPanel(
      PanelKeysConst.fileViewer,
      title,
      params,
      `${PanelKeysConst.fileViewer}:${documentKey}`,
    )
      .then((outcome) => {
        WorkspacePanels.reportPanelOpen(outcome)
        return outcome
      })
  }

  /**
   * Which session a command acts on. An explicit argument names the session of a clicked tree row -
   * one that may have no tab in this window, so there is no panel to name - and no argument means
   * the paths that existed before the tree: the session behind the active tab.
   */
  static commandTargetOf(
    controller: TabsController,
    arg: { sessionId?: string } | undefined,
  ): { sessionId: string; panelId: string | null } | null {
    if (arg?.sessionId !== undefined)
      return { sessionId: arg.sessionId, panelId: null }
    const active = WorkspacePanels.activeTerminalOf(controller.activePanelId())
    if (active === null)
      return null
    if (active.target.kind === 'local')
      return { sessionId: active.target.sessionId, panelId: active.panelId }
    else if (active.target.kind === 'remote')
      return null
    else
      throw new Error(`Unknown terminal target: ${JSON.stringify(active.target)}`)
  }

  /**
   * One directory tab per project, whichever row asked for it. Folded the way the tree already folds
   * a project path, because the two rows for one project - the sessions tree's and the tabs tree's -
   * and the same row after a restart that met another session first are all the same directory.
   * Not `FileViewer.panelKeyOf`: that hashes the session in as well, and the session here is only
   * what the grant is proved against.
   */
  static projectFolderKeyOf(path: string): string {
    return `project:${path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()}`
  }

  /** The last segment, which is all a tab has room for; the whole path stays in the panel. */
  static leafOf(path: string, fallback: string): string {
    return path.split(/[/\\]/).filter(Boolean).pop() ?? fallback
  }

  /**
   * A directory tab at one path, opened from a detection the main process already proved. The panel
   * id comes from the key main derived from the session and that path, so asking for the same
   * directory twice activates the tab that is open instead of stacking a second one, exactly as the
   * project folder does for a session. What lands in the layout is the address only: the panel asks
   * `directory-at` for a fresh grant every time it mounts.
   */
  static openDirectoryAt(
    controller: TabsController,
    sessionId: string,
    path: string,
    directoryKey: string,
  ): void {
    void controller.openPanel(
      PanelKeysConst.directoryViewer,
      WorkspacePanels.leafOf(path, 'Directory'),
      { sessionId, path },
      `${PanelKeysConst.directoryViewer}:${directoryKey}`,
    ).then((outcome) => WorkspacePanels.reportPanelOpen(outcome))
  }

  /**
   * The tree names the session; the tab menu names nothing, and there the session is read off the
   * active panel's own params - which any panel of a session's carries, the file and directory
   * viewers included, so that fallback is deliberately wider than the terminal reading.
   */
  static openProjectFolder(controller: TabsController, target: string | null): void {
    const sessionId = target ?? WorkspacePanels.activePanelSessionId(controller)
    if (sessionId === null) return
    void controller.openPanel(
      PanelKeysConst.directoryViewer,
      'Project Folder',
      { sessionId },
      `${PanelKeysConst.directoryViewer}:${sessionId}`,
    ).then((outcome) => WorkspacePanels.reportPanelOpen(outcome))
  }

  static activePanelSessionId(controller: TabsController): string | null {
    const activePanelId = controller.activePanelId()
    if (activePanelId === null || controller.keyOf(activePanelId) === PanelKeysConst.welcome) return null
    const sessionId = controller.transferPayload(activePanelId).params.sessionId
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  }

  static async closeActive(controller: TabsController): Promise<void> {
    const panelId = controller.activePanelId()
    if (panelId === null)
      return
    let splitClosed = false
    if (controller.keyOf(panelId) === PanelKeysConst.terminal)
      controller.applyPanelParameters(panelId, (params) => {
        const split = PanelSplitParams.of(params)
        if (split.active === null)
          return params
        splitClosed = true
        return PanelSplitParams.merged(params, PanelSplitParams.closed(split, split.active))
      })
    if (!splitClosed)
      await controller.hidePanel(panelId)
  }

  static backInSplit(controller: TabsController): void {
    const panelId = controller.activePanelId()
    if (panelId === null || controller.keyOf(panelId) !== PanelKeysConst.terminal)
      return
    controller.applyPanelParameters(panelId, (params) => {
      const current = PanelSplitParams.of(params)
      const result = PanelSplitParams.navigatedBack(current)
      if (!result.ok) {
        AppClientUiReport.error(result.refusal)
        return params
      }
      return result.state === current ? params : PanelSplitParams.merged(params, result.state)
    })
  }

  /**
   * One tab per session, for free: the panel id is derived from the key and the params, so a second
   * request for the same session activates the tab that is already open rather than attaching twice.
   * The title is written here when the tab opens - the panel reads no snapshot - and kept in step
   * afterwards by the shell's snapshot effect calling `applySessionTitles`.
   */
  static openTerminal(
    controller: TabsController,
    target: TerminalTarget,
    title: string,
    options?: { plain?: true; preview?: true; activate?: boolean },
  ): Promise<PanelOpenOutcome> {
    // A session already on screen as a plain tab is shown THERE. The two presentations derive
    // different panel ids from the same session, so opening the other one would put one session in
    // two tabs - which every row action can now reach, not just a click on the name.
    if (target.kind === 'local') {
      const plainPanelId = TabsController.panelIdOf(
        PanelKeysConst.terminal,
        TerminalTargetCodec.params(target, 'tab'),
      )
      if (options?.plain !== true && controller.keyOf(plainPanelId) !== null) {
        if (options?.activate !== false) controller.activatePanel(plainPanelId)
        return Promise.resolve({ kind: 'opened', panelId: plainPanelId })
      }
    } else if (target.kind === 'remote') {
      if (options?.plain === true)
        throw new Error('A remote terminal cannot be opened as a plain tab')
    } else
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
    return controller.openPanel(
      PanelKeysConst.terminal,
      title,
      TerminalTargetCodec.params(target, options?.plain === true ? 'tab' : 'session'),
      undefined,
      options,
    )
  }

  static async runTabControlCommand(
    controller: TabsController,
    command: TabControlCommand,
  ): Promise<void> {
    let result: TabControlCommandResult
    try {
      result = await WorkspacePanels.tabControlResult(controller, command)
    } catch (error) {
      result = { kind: 'failed', detail: ErrorText.of(error) }
    }
    const acknowledged = await window.appClient.tabs.controlAck({
      requestId: command.requestId,
      result,
    })
    if (!acknowledged.ok)
      throw new Error(acknowledged.error)
  }

  static async tabControlResult(
    controller: TabsController,
    command: TabControlCommand,
  ): Promise<TabControlCommandResult> {
    if (command.kind === 'open-session') {
      const outcome = await WorkspacePanels.openTerminal(
        controller,
        { kind: 'local', sessionId: command.sessionId },
        command.tabTitle,
        { ...(command.plain ? { plain: true } : {}), ...(command.activate === undefined ? {} : { activate: command.activate }) },
      )
      if (outcome.kind === 'opened')
        return { kind: 'opened', panelId: outcome.panelId }
      else if (outcome.kind === 'focusedExisting')
        return {
          kind: 'focused-existing',
          panelId: outcome.panelId,
          windowId: outcome.windowId,
        }
      else if (outcome.kind === 'failed')
        return outcome
      else
        throw new Error(`Unknown panel open outcome: ${JSON.stringify(outcome)}`)
    } else if (command.kind === 'open-file') {
      if (controller.keyOf(command.panelId) !== PanelKeysConst.terminal)
        return { kind: 'failed', detail: `Not a terminal panel: ${command.panelId}` }
      try {
        const applied = controller.applyPanelParameters(command.panelId, (params) => {
          const result = PanelSplitParams.opened(PanelSplitParams.of(params), {
            kind: 'file',
            key: command.documentKey,
            title: command.title,
            source: command.source,
          })
          if (!result.ok)
            throw new Error(result.refusal)
          return PanelSplitParams.merged(params, result.state)
        })
        return applied
          ? { kind: 'file-opened', panelId: command.panelId }
          : { kind: 'failed', detail: `Unknown panel: ${command.panelId}` }
      } catch (error) {
        return { kind: 'failed', detail: ErrorText.of(error) }
      }
    } else if (command.kind === 'open-commit') {
      if (controller.keyOf(command.panelId) !== PanelKeysConst.terminal)
        return { kind: 'failed', detail: `Not a terminal panel: ${command.panelId}` }
      let refusal: string | null = null
      const applied = controller.applyPanelParameters(command.panelId, (params) => {
        const result = PanelSplitParams.opened(PanelSplitParams.of(params), {
          kind: 'commit', key: PanelSplitParams.commitKeyOf(command.vcs, command.scopeRoot), title: command.title,
          vcs: command.vcs, scopeRoot: command.scopeRoot,
        })
        if (!result.ok) { refusal = result.refusal; return params }
        return PanelSplitParams.merged(params, result.state)
      })
      if (applied && refusal === null && command.activate !== false) {
        controller.activatePanel(command.panelId)
        requestAnimationFrame(() => controller.focusPanelContent(command.panelId))
      }
      return refusal !== null ? { kind: 'failed', detail: refusal }
        : applied ? { kind: 'commit-opened', panelId: command.panelId } : { kind: 'failed', detail: `Unknown panel: ${command.panelId}` }
    } else if (command.kind === 'focus-panel')
      return controller.activatePanel(command.panelId)
        ? { kind: 'focused', panelId: command.panelId }
        : { kind: 'failed', detail: `Unknown panel: ${command.panelId}` }
    else if (command.kind === 'close-panel') {
      if (controller.keyOf(command.panelId) === null)
        return { kind: 'failed', detail: `Unknown panel: ${command.panelId}` }
      await controller.hidePanel(command.panelId)
      return controller.keyOf(command.panelId) === null
        ? { kind: 'closed', panelId: command.panelId }
        : { kind: 'failed', detail: `Panel remained open: ${command.panelId}` }
    } else
      throw new Error(`Unknown tab control command: ${JSON.stringify(command)}`)
  }

  /**
   * What the tree means, in the controller's vocabulary. A permanent open passes no option at all,
   * so nothing but the tree can turn a tab provisional by accident.
   */
  static openOptionsOf(intent: SessionOpenIntent): { preview: true } | undefined {
    if (intent === 'preview')
      return { preview: true }
    else if (intent === 'permanent')
      return undefined
    else
      throw new Error(`Unknown session open intent: ${JSON.stringify(intent)}`)
  }

  /**
   * A plain tab becomes a session of the tree. The panel id is derived from the parameters, and the
   * parameters are what say which of the two a tab is, so the tab is re-keyed rather than updated:
   * closed silently, so nothing ends what was just kept, and opened again under the tree's shape
   * with the title the promotion gave it.
   *
   * The re-key is why this one target genuinely needs a panel: a named session resolves to the
   * plain panel this window would derive for it, and a window that does not hold that panel refuses
   * with a log rather than promoting a record whose tab it cannot re-key.
   */
  static async promoteTab(
    controller: TabsController,
    sessionId: string | null,
  ): Promise<void> {
    const plain = sessionId === null
      ? WorkspacePanels.plainTabOf(controller.activePanelId())
      : WorkspacePanels.plainPanelFor(controller, sessionId)
    if (plain === null) {
      if (sessionId !== null)
        AppClientUiReport.error(
          `promote: no plain tab in this window for session ${sessionId}`,
        )
      return
    }
    const answer = await window.appClient.sessions.promotePlain(plain.sessionId)
    const refusal = IpcFailure.of(answer, 'Keeping the tab as a session')
    if (refusal !== null) {
      AppClientUiReport.error(`${refusal}`)
      return
    }
    if (!answer.ok || !answer.value.ok)
      return
    await controller.hidePanel(plain.panelId, { silent: true })
    const outcome = await WorkspacePanels.openTerminal(
      controller,
      { kind: 'local', sessionId: plain.sessionId },
      answer.value.value.tabTitle,
    )
    if (outcome.kind === 'failed')
      AppClientUiReport.error(`${outcome.detail}`)
    else if (outcome.kind !== 'opened' && outcome.kind !== 'focusedExisting')
      throw new Error(`Unknown panel open outcome: ${JSON.stringify(outcome)}`)
  }

  /** The plain tab a named session is drawn by, where THIS window holds it. Null anywhere else. */
  static plainPanelFor(
    controller: TabsController,
    sessionId: string,
  ): { panelId: string; sessionId: string } | null {
    const panelId = TabsController.panelIdOf(
      PanelKeysConst.terminal,
      TerminalTargetCodec.params({ kind: 'local', sessionId }, 'tab'),
    )
    return controller.keyOf(panelId) === null ? null : { panelId, sessionId }
  }

  /** The session behind the active tab, where that tab is a plain one. Null for anything else. */
  static plainTabOf(panelId: string | null): { panelId: string; sessionId: string } | null {
    const read = TerminalTargetCodec.read(WorkspacePanels.terminalParamsIn(panelId))
    if (panelId === null || read === null || read.presentation !== 'tab')
      return null
    if (read.target.kind === 'local')
      return { panelId, sessionId: read.target.sessionId }
    else if (read.target.kind === 'remote')
      return null
    else
      throw new Error(`Unknown terminal target: ${JSON.stringify(read.target)}`)
  }

  /**
   * The terminal behind the active tab, whichever of the two presentations it is: both draw a
   * session, and the widgets that read this are about the session rather than about the tab.
   */
  static activeTerminalOf(panelId: string | null): ActiveTerminalReading | null {
    const read = TerminalTargetCodec.read(WorkspacePanels.terminalParamsIn(panelId))
    if (panelId === null || read === null)
      return null
    return { panelId, target: read.target }
  }

  /**
   * The parameters a panel id was derived from, for the two readers above. The id is the key and the
   * serialized params, so anything that is not a terminal panel answers null and neither of them
   * has to know how the derivation is spelled.
   */
  static terminalParamsIn(
    panelId: string | null,
  ): Record<string, unknown> | null {
    if (panelId === null)
      return null
    const marker = `${PanelKeysConst.terminal}:`
    if (!panelId.startsWith(marker))
      return null
    const params: unknown = JSON.parse(panelId.slice(marker.length))
    if (typeof params !== 'object' || params === null || Array.isArray(params))
      return null
    return params as Record<string, unknown>
  }

  /** The probe is the only panel this shell can meaningfully open a new one of. */
  static openProbe(controller: TabsController): void {
    WorkspacePanels.probeIndex += 1
    void controller.openPanel(
      PanelKeysConst.probe,
      `${WorkspacePanels.probeTitleConst} ${WorkspacePanels.probeIndex}`,
      { serial: crypto.randomUUID() },
    ).then((outcome) => WorkspacePanels.reportPanelOpen(outcome))
  }

  static reportPanelOpen(outcome: PanelOpenOutcome): void {
    if (outcome.kind === 'failed')
      AppClientUiReport.error(`${outcome.detail}`)
    else if (outcome.kind === 'opened' || outcome.kind === 'focusedExisting')
      return
    else
      throw new Error(`Unknown panel open outcome: ${JSON.stringify(outcome)}`)
  }

  static reportTabsError(error: unknown): void {
    AppClientUiReport.error(`tabs operation failed: ${ErrorText.of(error)}`)
  }

  /**
   * A command handler starts work and does not wait for it, so a rejection has no caller left.
   *
   * Every one of these already reports the failures it HANDLES - through `IpcFailure.of`, or through
   * `reportTabsError`. Where the promise itself rejected the user got nothing: `tab.close` left the
   * tab standing and said so nowhere, `tab.promote` left the record promoted with the old tab still
   * keyed as plain, `tab.resetLayout` stopped halfway through the panels it was closing.
   */
  static started(what: string, work: Promise<unknown>): void {
    void work.catch((error: unknown) =>
      AppClientUiReport.error(`${what} failed: ${ErrorText.of(error)}`))
  }

  static async finishTransferOut(controller: TabsController, panelId: string): Promise<void> {
    await controller.removeTransferred(panelId)
    if (controller.panelCount() === 0)
      await controller.clearLayoutOrThrow()
    else
      await controller.flushLayoutOrThrow()
  }

  static closeOthers(controller: TabsController): void {
    const panelId = controller.activePanelId()
    if (panelId)
      void controller.closeOtherPanels(panelId)
  }

  static async restore(
    controller: TabsController,
    sessionsSnapshot: SnapshotStore<SessionsSnapshot>,
    remoteSnapshot: SnapshotStore<RemoteConnectionsSnapshot>,
  ): Promise<void> {
    try {
      const loaded = await window.appClient.state.loadLayout()
      if (loaded.ok)
        await controller.restoreAndReconcile(loaded.value.layout, loaded.value.failed)
      else {
        AppClientUiReport.error(`layout unavailable: ${loaded.error}`)
        await controller.restoreAndReconcile(null, true)
      }
      // The boot's only snapshot publication can land BEFORE these panels existed to hear it -
      // subscribe does not replay, and the revision gate refuses a refetch - so a restored tab
      // would keep a pre-rename title until the next sessions event. One catch-up closes the gap.
      const sessions = sessionsSnapshot.current().snapshot?.sessions
      if (sessions !== undefined)
        controller.applySessionTitles(sessions)
      const remote = remoteSnapshot.current().snapshot?.outbound
      if (remote !== undefined)
        controller.applyRemoteSessionTitles(remote.map((endpoint) => ({
          remoteEndpointId: endpoint.remoteEndpointId,
          titles: endpoint.sessions?.sessions ?? [],
        })))
    } catch (error) {
      AppClientUiReport.error(`layout restore failed: ${ErrorText.of(error)}`)
    } finally {
      try {
        const ready = await window.appClient.rendererReady()
        if (!ready.ok)
          AppClientUiReport.error(`renderer readiness unavailable: ${ready.error}`)
      } catch (error) {
        AppClientUiReport.error(`renderer readiness failed: ${ErrorText.of(error)}`)
      }
    }
  }
}
