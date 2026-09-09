import { PanelKeysConst } from '../../shared/tabTransfer'
import { randomUUID } from 'node:crypto'

import type { WebContents } from 'electron'

import { ErrorText } from '../../shared/errorText'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import type { TabControlBroker } from './tabControlBroker'
import type { TabTransferBroker } from './tabTransferBroker'
import type { WorkspacePanelIndex } from './workspacePanelIndex'

/** Panel ownership and cross-window transfer routing. */
export class ServiceTabsIpc extends ServiceIpcBase<typeof ServiceTabsIpc.channelsConst> {
  static readonly channelsConst = {
    'tabs:claim-panel': true,
    'tabs:reconcile-panels': true,
    'tabs:release-panel': true,
    'tabs:set-active-panel': true,
    'tabs:open-session-ids': true,
    'tabs:close-terminal-panel': true,
    'tabs:publish-terminal-restarted': true,
    'tabs:drag-started': true,
    'tabs:transfer-prepare': true,
    'tabs:transfer-commit': true,
    'tabs:transfer-abort': true,
    'tabs:move-panel': true,
    'tabs:control-ack': true,
  } as const

  constructor(
    private readonly windows: WorkspaceWindows,
    private readonly index: WorkspacePanelIndex,
    private readonly broker: TabTransferBroker,
    private readonly controlBroker: TabControlBroker,
    private readonly onPresenceChanged: () => void,
  ) {
    super()
  }

  initialize(): void {
    this.register('tabs:claim-panel', (event, panel) => {
      const windowId = this.windows.windowIdOf(event.sender)
      if (windowId === null)
        return { kind: 'refused', detail: 'Unknown workspace renderer' }
      if (!this.windows.acceptsRenderer(event.sender))
        return { kind: 'refused', detail: 'The workspace window is closing' }
      const answer = this.index.claimOpen(windowId, panel)
      if (answer.kind === 'owned') {
        this.windows.focusOrRecreate(answer.windowId)
        // A terminal owns renderer-local split and sidebar state inside its params. A duplicate
        // open only focuses that tab; publishing the request's base params would erase that state.
        if (panel.key === PanelKeysConst.terminal)
          this.windows.publishTo(answer.windowId, 'tabs:activate-panel', answer.panelId)
        else
          this.windows.publishTo(
            answer.windowId,
            'tabs:activate-panel',
            answer.panelId,
            panel.params,
            panel.title,
          )
      } else if (answer.kind === 'granted') {
        this.announcePresence()
        return answer
      } else if (answer.kind === 'refused')
        return answer
      else
        throw new Error(`Unknown panel claim result: ${JSON.stringify(answer)}`)
      return answer
    })
    this.register('tabs:reconcile-panels', (event, panels) => {
      const windowId = this.windows.windowIdOf(event.sender)
      if (windowId === null || !this.windows.acceptsRenderer(event.sender))
        return { acceptedPanelIds: [], rejectedPanelIds: panels.map((panel) => panel.panelId) }
      const answer = this.index.reconcile(windowId, panels)
      this.announcePresence()
      return answer
    })
    this.register('tabs:release-panel', (event, panelId) => {
      this.index.release(panelId, this.requireWindowId(event.sender))
      this.announcePresence()
    })
    this.register('tabs:set-active-panel', (event, panelId) => {
      this.index.setActivePanel(this.requireWindowId(event.sender), panelId)
      this.announcePresence()
    })
    this.register('tabs:open-session-ids', (event) => {
      this.requireMain(event.sender)
      return this.index.openSessionIds()
    })
    this.register('tabs:close-terminal-panel', (event, targetKey) => {
      this.requireMain(event.sender)
      for (const owner of this.index.panelsOfTerminalTarget(targetKey))
        this.windows.publishTo(owner.windowId, 'tabs:close-panel', owner.panel.panelId)
    })
    this.register('tabs:publish-terminal-restarted', (event, targetKey) => {
      // Any accepting window, unlike the two channels above it. `session.restart` is a
      // `windowScope: 'any'` command with an accelerator, so a holder can run it - and it did:
      // the restart itself succeeded and only the announcement was refused, which left every
      // panel drawing that session attached to a runtime that had just been replaced. This
      // publishes only to windows that already own a panel for the target, so a holder gains
      // nothing here it did not already have.
      this.requireAcceptingWindowId(event.sender)
      const notified = new Set<string>()
      for (const owner of this.index.panelsOfTerminalTarget(targetKey))
        if (!notified.has(owner.windowId)) {
          notified.add(owner.windowId)
          this.windows.publishTo(owner.windowId, 'tabs:terminal-restarted', targetKey)
        }
    })
    this.register('tabs:drag-started', (event, token, panel) => {
      const sourceWindowId = this.requireAcceptingWindowId(event.sender)
      if (panel.key === PanelKeysConst.welcome)
        throw new Error('The welcome panel cannot be transferred')
      this.broker.start(token, panel, sourceWindowId)
    })
    this.register('tabs:transfer-prepare', (event, token) =>
      this.broker.prepare(token, this.requireAcceptingWindowId(event.sender)))
    this.register('tabs:transfer-commit', (event, token) => {
      this.broker.commit(token, this.requireWindowId(event.sender))
      this.announcePresence()
    })
    this.register('tabs:transfer-abort', (event, token) => {
      this.broker.abort(token, this.requireWindowId(event.sender))
    })
    this.register('tabs:move-panel', async (event, panel, target) => {
      const sourceWindowId = this.requireAcceptingWindowId(event.sender)
      if (panel.key === PanelKeysConst.welcome)
        return
      let targetWindowId: string
      if (target.kind === 'newWindow')
        targetWindowId = this.windows.createHolder().windowId
      else if (target.kind === 'window') {
        targetWindowId = target.windowId
        this.windows.focusOrRecreate(targetWindowId)
      } else
        throw new Error(`Unknown tab move target: ${JSON.stringify(target)}`)
      if (targetWindowId === sourceWindowId)
        return
      // The wait comes first, and the token after it. Registered before, the token spends its whole
      // thirty-second life waiting for a window that may be slow to load - and a wait longer than
      // that publishes a token the broker has already reaped, which is a move that silently does
      // nothing. A window that will never load rejects here instead, which the renderer can report.
      await this.windows.whenRendererReady(targetWindowId)
      const token = randomUUID()
      this.broker.start(token, panel, sourceWindowId)
      this.windows.publishTo(targetWindowId, 'tabs:transfer-in', token)
    })
    this.register('tabs:control-ack', (event, ack) => {
      this.controlBroker.acknowledge(this.requireWindowId(event.sender), ack)
    })
    this.assertComplete(ServiceTabsIpc.channelsConst)
  }

  private requireWindowId(sender: WebContents): string {
    const windowId = this.windows.windowIdOf(sender)
    if (windowId === null)
      throw new Error('Unknown workspace renderer')
    return windowId
  }

  private requireMain(sender: WebContents): void {
    if (this.windows.roleOf(sender) !== 'main')
      throw new Error('This tabs operation is main-only')
  }

  private requireAcceptingWindowId(sender: WebContents): string {
    const windowId = this.requireWindowId(sender)
    if (!this.windows.acceptsRenderer(sender))
      throw new Error(`The workspace window is closing: ${windowId}`)
    return windowId
  }

  /**
   * The presence callback, for every channel that has already changed the index by the time it runs.
   *
   * All five mutate ownership first and announce second, so a throw from the announcement leaves the
   * index and the renderer disagreeing with nothing to reconcile them. The claim is the worst of
   * them: the renderer is told its claim failed and drops the panel while the index still names the
   * window as owner, so that session can never be claimed again.
   *
   * Nothing in `tabsPresenceChanged` throws today - this is defence in depth, and the commit path
   * has had it since the transfer work.
   */
  private announcePresence(): void {
    try {
      this.onPresenceChanged()
    } catch (error) {
      ServiceTabsIpc.reportPresenceFailure(error)
    }
  }

  private static reportPresenceFailure(error: unknown): void {
    try {
      console.error(`Tab presence could not be published: ${ErrorText.of(error)}`)
    } catch {}
  }
}
