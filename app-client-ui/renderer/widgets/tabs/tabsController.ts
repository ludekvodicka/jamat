import type {
  AddPanelPositionOptions,
  DockviewApi,
  DockviewDidDropEvent,
  DockviewGroupPanel,
  DockviewIDisposable,
  IDockviewPanel,
  SerializedDockview,
} from 'dockview'

import { ErrorText } from '../../../shared/errorText'
import { TerminalTargetCodec } from '../../../shared/terminalTarget'
import type {
  ClaimPanelResult,
  ReconcilePanelsResult,
  TabDropPlacement,
  TabMoveTarget,
  TabTransferLease,
  TabTransferPayload,
  WorkspacePanelPresence,
} from '../../../shared/tabTransfer'
import { PanelKeysConst, TabTransferDrag } from '../../../shared/tabTransfer'
import { WorkspaceSaveLimits } from '../workspaceSaveLimits'
import type { PanelOpenOutcome } from '../../shell/appShell.types'
import type { PanelRegistry } from './panelRegistry'
import { type MoveDirection, type TabGroupBox, TabGroupNeighbour } from './tabGroupNeighbour'

type LayoutWrite = { kind: 'save'; layout: string } | { kind: 'clear' }

/**
 * The two directions this shell splits in; dockview's own vocabulary for the second one is 'below'.
 * A subset of the four a panel MOVES in rather than a list of its own, so the two cannot drift and
 * `positionOf` answers both.
 */
export type SplitDirection = Extract<MoveDirection, 'right' | 'below'>

export interface TabsControllerPorts {
  registry: PanelRegistry
  /** Answers whether the layout reached disk; the controller advances its cursor only on true. */
  saveLayout(layout: string): Promise<boolean>
  clearLayout(): Promise<boolean>
  claimPanel(panel: WorkspacePanelPresence, activate?: boolean): Promise<ClaimPanelResult>
  focusPanelContent?(panelId: string): void
  reconcilePanels(panels: readonly WorkspacePanelPresence[]): Promise<ReconcilePanelsResult>
  releasePanel(panelId: string): Promise<void>
  setActivePanel(panelId: string | null): Promise<void>
  tabDragStarted(token: string, panel: TabTransferPayload): Promise<void>
  transferPrepare(token: string): Promise<TabTransferLease | null>
  transferCommit(token: string): Promise<void>
  transferAbort(token: string): Promise<void>
  movePanel(panel: TabTransferPayload, target: TabMoveTarget): Promise<void>
  reportError(message: string): void
  /**
   * Asked before a panel a PERSON is closing goes, and only then: the four paths below are the ones
   * a click can reach, and the window tearing down empties dockview without passing through any of
   * them. `false` leaves the panel where it is.
   *
   * It exists for the one panel whose tab is the only place its session is drawn - closing that IS
   * ending it - and every other panel answers `true` without being asked anything.
   */
  onWillUserClose?(key: string, params: Record<string, unknown>): Promise<boolean>
}

/**
 * Everything the tab container does, away from the shell that used to do it inline. The rules it
 * carries are the ones a workspace gets wrong quietly: a panel key is stable because layouts are
 * serialized against it, a failed restore never overwrites the document it failed to read, and
 * closing a tab hides a panel and never ends a runtime.
 */
export class TabsController {
  private api: DockviewApi | null = null
  /**
   * What this controller is listening to on the api it is attached to. One list rather than seven
   * fields: they were released in `attach` and again in `dispose`, so an eighth event had to be
   * added to both, and the one that was forgotten would keep firing into a controller nobody holds.
   */
  private subscriptions: DockviewIDisposable[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The one tab this window is holding provisionally. It is renderer state and stays here: panel
   * params derive the panel id, so a flag kept there would make the same session two different
   * panels, and the layout, the index and the transfer payload would all carry it back.
   */
  private previewPanelId: string | null = null
  private readonly previewListeners = new Set<() => void>()
  /** User-closed panels can return with their last sidebar and inner split state in this window. */
  private readonly closedPanelParameters = new Map<string, Record<string, unknown>>()
  /** Latched on a failed restore: saving now would overwrite the layout we could not read. */
  private restoreFailed = false
  private emptyRefusalReported = false
  /** The last layout this session read or STORED; a save that would repeat it is not a change. */
  private persistedLayout: string | null = null
  private writeTail: Promise<void> = Promise.resolve()
  private indexReady = false
  private receivingTransferCount = 0

  constructor(private readonly ports: TabsControllerPorts) {}

  attach(api: DockviewApi): void {
    // The previous subscriptions go with the api they were made on: two live ones would save every
    // layout change twice, and the second write would be the one nobody looked for.
    this.releaseSubscriptions()
    this.api = api
    this.subscriptions.push(api.onDidLayoutChange(() => this.scheduleSave()))
    // Its own event, though `onDidLayoutChange` carries it too: that one also fires for every
    // splitter drag and every panel added, and what hangs off this one redraws on the answer.
    this.subscriptions.push(api.onDidActivePanelChange(() => this.notifyActivePanel()))
    this.subscriptions.push(api.onDidRemovePanel((panel) => {
      void this.ports.releasePanel(panel.id)
        .catch((error: unknown) => this.report('Panel ownership could not be released', error))
      // Every way a panel leaves passes here: the cross, a replacement, a transfer out, close-others
      // and the reset. One line, instead of the same line on each of those paths.
      if (panel.id === this.previewPanelId)
        this.setPreviewPanelId(null)
    }))
    // A tab someone MOVED is a tab someone decided to keep: dockview reports the move once it has
    // happened, unlike `onWillDragPanel`, which fires on a drag that may still be abandoned.
    this.subscriptions.push(api.onDidMovePanel((event) => this.keepOpen(event.panel.id)))
    this.subscriptions.push(api.onWillDragPanel((event) => {
      if (event.panel.view.contentComponent === PanelKeysConst.welcome)
        return
      const dataTransfer = event.nativeEvent.dataTransfer
      if (dataTransfer === null)
        return
      const token = crypto.randomUUID()
      TabTransferDrag.write(dataTransfer, token)
      dataTransfer.effectAllowed = 'move'
      void this.ports.tabDragStarted(token, this.transferPayload(event.panel.id))
        .catch((error: unknown) => this.report('Tab drag could not be registered', error))
    }))
    this.subscriptions.push(api.onUnhandledDragOverEvent((event) => {
      if (TabTransferDrag.mayContainToken(event.nativeEvent.dataTransfer))
        event.accept()
    }))
    this.subscriptions.push(api.onDidDrop((event) => {
      const token = TabTransferDrag.tokenOf(event.nativeEvent.dataTransfer)
      if (token !== null)
        void this.receiveTransfer(token, TabsController.placementOf(event))
          .catch((error: unknown) => this.report('Tab transfer failed', error))
    }))
  }

  private notifyActivePanel(): void {
    if (this.indexReady && this.receivingTransferCount === 0)
      void this.ports.setActivePanel(this.indexedActivePanelId())
        .catch((error: unknown) => this.report('Active panel could not be published', error))
  }

  /** Panel ids are derived, not random: reopening the same thing must find the same panel. */
  static panelIdOf(key: string, params: Record<string, unknown>): string {
    return `${key}:${JSON.stringify(params)}`
  }

  /**
   * Brings a panel that already exists to the front, and says whether there was one. For a caller
   * that can name the same thing in more than one way: it has to be able to ask before it opens,
   * or it opens a second panel onto what is already on screen.
   */
  activatePanel(
    panelId: string,
    params?: Record<string, unknown>,
    title?: string,
  ): boolean {
    const panel = this.api?.getPanel(panelId)
    if (!panel)
      return false
    if (params !== undefined) panel.api.updateParameters(params)
    if (title !== undefined) panel.api.setTitle(title)
    panel.api.setActive()
    return true
  }

  applyPanelParameters(
    panelId: string,
    merge: (params: Record<string, unknown>) => Record<string, unknown>,
  ): boolean {
    const panel = this.api?.getPanel(panelId)
    if (!panel)
      return false
    const current = { ...(panel.params ?? {}) }
    const next = merge(current)
    if (next !== current)
      panel.api.updateParameters(next)
    return true
  }

  /** For `useSyncExternalStore` in the tab; the snapshot is `isPreview`, which is a primitive. */
  subscribePreview(listener: () => void): () => void {
    this.previewListeners.add(listener)
    return () => {
      this.previewListeners.delete(listener)
    }
  }

  isPreview(panelId: string): boolean {
    return this.previewPanelId === panelId
  }

  /** Promotion: the tab stops being provisional and stays until someone closes it. */
  keepOpen(panelId: string): void {
    if (panelId === this.previewPanelId)
      this.setPreviewPanelId(null)
  }

  private setPreviewPanelId(next: string | null): void {
    if (next === this.previewPanelId)
      return
    this.previewPanelId = next
    for (const listener of this.previewListeners)
      listener()
  }

  async openPanel(
    key: string,
    title: string,
    params: Record<string, unknown> = {},
    panelId?: string,
    options?: { preview?: true; activate?: boolean },
  ): Promise<PanelOpenOutcome> {
    let granted: string | null = null
    try {
      // A plain tab is the one panel whose close ENDS its session, and a preview is closed silently
      // for the next one. Loud here, rather than a dropped flag that would only be noticed the day
      // a replacement killed a running agent.
      if (options?.preview === true
        && key === PanelKeysConst.terminal
        && params.presentation === 'tab')
        throw new Error(`A plain tab is never a preview: ${JSON.stringify(params)}`)
      this.ports.registry.assertComponent(key)
      const resolvedPanelId = panelId ?? TabsController.panelIdOf(key, params)
      const remembered = this.closedPanelParameters.get(resolvedPanelId)
      const openingParameters = remembered === undefined ? params : { ...remembered, ...params }
      const presence = this.presenceOf(
        key,
        title,
        openingParameters,
        resolvedPanelId,
      )
      const api = this.requireApi()
      const existing = api.getPanel(presence.panelId)
      if (existing) {
        this.closedPanelParameters.delete(presence.panelId)
        return this.focusExisting(existing, presence.panelId, title, params, panelId !== undefined, options)
      }
      const claim = await this.ports.claimPanel(presence, options?.activate)
      if (claim.kind === 'owned')
        return {
          kind: 'focusedExisting',
          panelId: claim.panelId,
          windowId: claim.windowId,
        }
      else if (claim.kind === 'refused')
        return { kind: 'failed', detail: claim.detail }
      else if (claim.kind !== 'granted')
        throw new Error(`Unknown panel claim result: ${JSON.stringify(claim)}`)
      granted = presence.panelId
      // The claim was awaited, and a second click on the same row arrives during exactly that gap.
      // Whoever got here first has already added this panel, and dockview refuses a duplicate id;
      // the claim is not released, because that first panel is live and holds it.
      const raced = api.getPanel(presence.panelId)
      if (raced) {
        granted = null
        this.closedPanelParameters.delete(presence.panelId)
        return this.focusExisting(raced, presence.panelId, title, params, panelId !== undefined, options)
      }
      // Read here rather than before the claim: what this window was holding provisionally may have
      // changed while the claim was in flight.
      const oldPreviewId = this.previewPanelId
      const position = this.replacementPositionOf(oldPreviewId)
      api.addPanel({
        id: presence.panelId,
        component: key,
        title,
        params: openingParameters,
        ...(options?.activate === false ? { inactive: true } : {}),
        ...(position === null ? {} : { position }),
      })
      this.closedPanelParameters.delete(presence.panelId)
      if (options?.preview === true) {
        // The new flag is set BEFORE the old panel goes, so the cleanup in `onDidRemovePanel` -
        // which only fires on a matching id - cannot wipe the one just written. The close carries
        // its own catch: losing the old tab must not turn an open that SUCCEEDED into a failure,
        // which would release a claim this window is now using.
        this.setPreviewPanelId(presence.panelId)
        if (oldPreviewId !== null && oldPreviewId !== presence.panelId)
          await this.hidePanel(oldPreviewId, { silent: true })
            .catch((error: unknown) => this.report('The previous preview tab could not be closed', error))
      }
      return { kind: 'opened', panelId: presence.panelId }
    } catch (error) {
      if (granted !== null)
        await this.ports.releasePanel(granted)
          .catch((releaseError: unknown) =>
            this.report('Panel ownership could not be released', releaseError))
      return { kind: 'failed', detail: ErrorText.of(error) }
    }
  }

  /**
   * The panel asked for is already on screen. Bringing it to the front is the whole of it, except
   * for one thing: asking for it DELIBERATELY - a double-click, a launcher, a menu - is what turns a
   * provisional tab into one that stays. Nothing here ever replaces another panel; only a NEW
   * preview does that.
   */
  private focusExisting(
    panel: IDockviewPanel,
    panelId: string,
    title: string,
    params: Record<string, unknown>,
    rewrite: boolean,
    options?: { preview?: true; activate?: boolean },
  ): PanelOpenOutcome {
    if (rewrite) {
      panel.api.updateParameters(params)
      panel.api.setTitle(title)
    }
    if (options?.activate !== false) panel.api.setActive()
    if (options?.preview !== true && panelId === this.previewPanelId)
      this.setPreviewPanelId(null)
    return { kind: 'opened', panelId }
  }

  focusPanelContent(panelId: string): void {
    if (this.activePanelId() === panelId) this.ports.focusPanelContent?.(panelId)
  }

  /**
   * Where a replacing preview goes: onto the outgoing tab's own place, so the row of tabs does not
   * jump while someone reads down the tree. Only when that tab is in the group being looked at -
   * anywhere else the new panel belongs where any other new panel would go.
   */
  private replacementPositionOf(oldPreviewId: string | null): AddPanelPositionOptions | null {
    if (oldPreviewId === null)
      return null
    const api = this.requireApi()
    const old = api.getPanel(oldPreviewId)
    if (!old || old.group !== api.activeGroup)
      return null
    return {
      referenceGroup: old.group,
      direction: 'within',
      index: old.group.panels.indexOf(old),
    }
  }

  /** The one way in, so a reset, a failed restore and the watermark all open the same panel. */
  openWelcome(): void {
    const api = this.api
    if (!api)
      return
    const params = {}
    const id = TabsController.panelIdOf(PanelKeysConst.welcome, params)
    const existing = api.getPanel(id)
    if (existing) {
      existing.api.setActive()
      return
    }
    api.addPanel({
      id,
      component: PanelKeysConst.welcome,
      title: this.ports.registry.titleOf(PanelKeysConst.welcome),
      params,
    })
  }

  /** Moves the ACTIVE panel into a new group beside its own, through the public move API. */
  splitActivePanel(direction: SplitDirection): void {
    const api = this.api
    const panel = api?.activePanel
    if (!api || !panel)
      return
    // The only panel of the only group has nowhere to go: dockview answers by moving the group
    // beside itself, which rebuilds the grid for a layout that ends up identical.
    if (panel.group.panels.length < 2 && api.groups.length < 2)
      return
    panel.api.moveTo({ group: panel.group, position: TabsController.positionOf(direction) })
  }

  /**
   * Moves the ACTIVE panel to the group that lies that way, or splits its own group where nothing
   * does. V1's behaviour and V1's keys: the first press in a single-group window makes the second
   * group, and every press after that walks the panel across the ones already there.
   */
  moveActivePanelInDirection(direction: MoveDirection): void {
    const api = this.api
    const panel = api?.activePanel
    if (!api || !panel)
      return
    const neighbour = TabsController.neighbourOf(panel.group, direction, api.groups)
    if (neighbour !== null) {
      panel.api.moveTo({ group: neighbour, position: 'center' })
      return
    }
    // Nothing that way, so the panel leaves its own group instead - which it can only do if it
    // leaves something behind. The last panel of a group would be moved out of a group that then
    // vanishes, into a new one in the same place: a rebuilt grid for an identical layout.
    if (panel.group.panels.length < 2)
      return
    panel.api.moveTo({ group: panel.group, position: TabsController.positionOf(direction) })
  }

  /**
   * The tab cross. It removes a panel and, for all but one kind, touches no runtime: closing a tab
   * is not a decision about a PTY. The exception is asked for through `onWillUserClose`.
   *
   * `silent` skips that question, for a close this client is doing to itself - re-keying a promoted
   * tab - where ending the session is exactly what must not happen.
   */
  async hidePanel(panelId: string, options?: { silent?: true }): Promise<void> {
    const api = this.api
    const panel = api?.getPanel(panelId)
    if (!api || !panel)
      return
    if (options?.silent !== true && !await this.mayUserClose(panel))
      return
    // The panel may have gone while the question was being answered.
    if (!api.getPanel(panelId))
      return
    // The neighbour is read BEFORE the removal, because the group's panel list shrinks on remove.
    // Dockview's own answer is the group's LAST tab, which is not the tab next to the closed one.
    const wasActive = api.activePanel === panel
    const siblings = panel.group.panels
    const index = siblings.indexOf(panel)
    const neighbour = index >= 0 ? siblings[index + 1] ?? siblings[index - 1] : undefined
    const remembered = options?.silent === true ? null : { ...(panel.params ?? {}) }
    api.removePanel(panel)
    if (remembered !== null)
      this.closedPanelParameters.set(panelId, remembered)
    if (wasActive && neighbour && api.getPanel(neighbour.id))
      neighbour.api.setActive()
  }

  /**
   * Whether this panel may go. Panels the shell asks nothing about answer `true` at once, so the
   * ordinary close stays synchronous in everything but its type.
   */
  private async mayUserClose(panel: IDockviewPanel): Promise<boolean> {
    const ask = this.ports.onWillUserClose
    if (ask === undefined)
      return true
    return ask(panel.view.contentComponent, { ...panel.params })
  }

  /** What every surface that names no panel means: the menu, the accelerators, the context menu. */
  activePanelId(): string | null {
    return this.api?.activePanel?.id ?? null
  }

  keyOf(panelId: string): string | null {
    return this.api?.getPanel(panelId)?.view.contentComponent ?? null
  }

  /**
   * Rewrites the terminal panels whose session the snapshot now names differently. `setTitle` only
   * on a real difference: every window applies every snapshot, so a write without the comparison
   * would have two windows re-saving their layouts for names that already match.
   */
  applySessionTitles(titles: readonly { sessionId: string; tabTitle: string }[]): void {
    this.applyTerminalTitles(new Map(titles.map((title) => [
      TerminalTargetCodec.key({ kind: 'local', sessionId: title.sessionId }),
      title.tabTitle,
    ])))
  }

  applyRemoteSessionTitles(endpoints: readonly {
    remoteEndpointId: string
    titles: readonly { sessionId: string; tabTitle: string }[]
  }[]): void {
    this.applyTerminalTitles(new Map(endpoints.flatMap((endpoint) => endpoint.titles.map((title) => [
      TerminalTargetCodec.key({
        kind: 'remote',
        remoteEndpointId: endpoint.remoteEndpointId,
        sessionId: title.sessionId,
      }),
      title.tabTitle,
    ]))))
  }

  private applyTerminalTitles(byTarget: ReadonlyMap<string, string>): void {
    for (const panel of this.api?.panels ?? []) {
      if (panel.view.contentComponent !== PanelKeysConst.terminal)
        continue
      const reading = TerminalTargetCodec.read(panel.params)
      if (reading === null)
        continue
      const wanted = byTarget.get(TerminalTargetCodec.key(reading.target))
      if (wanted !== undefined && panel.title !== wanted)
        panel.api.setTitle(wanted)
    }
  }

  transferPayload(panelId: string): TabTransferPayload {
    const panel = this.requireApi().getPanel(panelId)
    if (!panel)
      throw new Error(`Unknown panel: ${panelId}`)
    if (panel.view.contentComponent === PanelKeysConst.welcome)
      throw new Error('The welcome panel cannot be transferred')
    return this.presenceOf(
      panel.view.contentComponent,
      panel.title ?? this.ports.registry.titleOf(panel.view.contentComponent),
      { ...panel.params },
      panel.id,
    )
  }

  async moveActivePanel(target: TabMoveTarget): Promise<void> {
    const panelId = this.activePanelId()
    if (panelId === null || this.keyOf(panelId) === PanelKeysConst.welcome)
      return
    await this.ports.movePanel(this.transferPayload(panelId), target)
  }

  hasOnlyWelcome(): boolean {
    const panels = this.api?.panels ?? []
    return panels.length === 1
      && panels[0]?.view.contentComponent === PanelKeysConst.welcome
  }

  addTransferredPanel(panel: TabTransferPayload, placement: TabDropPlacement): void {
    if (panel.key === PanelKeysConst.welcome)
      throw new Error('The welcome panel cannot be transferred')
    this.ports.registry.assertComponent(panel.key)
    const api = this.requireApi()
    if (api.getPanel(panel.panelId))
      throw new Error(`Transferred panel already exists: ${panel.panelId}`)
    const position = TabsController.addPositionOf(placement)
    api.addPanel({
      id: panel.panelId,
      component: panel.key,
      title: panel.title,
      params: { ...panel.params },
      ...(position === undefined ? {} : { position }),
    })
  }

  async removeTransferred(panelId: string): Promise<void> {
    await this.hidePanel(panelId, { silent: true })
  }

  async receiveTransfer(token: string, placement: TabDropPlacement): Promise<void> {
    const lease = await this.ports.transferPrepare(token)
    if (lease === null)
      return
    const hadSolitaryWelcome = this.hasOnlyWelcome()
    let added = false
    let welcomeRemoved = false
    this.receivingTransferCount += 1
    try {
      this.addTransferredPanel(lease.panel, placement)
      added = true
      if (hadSolitaryWelcome) {
        this.removeWelcomeSilently()
        welcomeRemoved = true
      }
      await this.flushLayoutOrThrow()
      await this.ports.transferCommit(token)
    } catch (error) {
      try {
        await this.ports.transferAbort(token)
      } catch (abortError) {
        this.report('Tab transfer abort failed', abortError)
      }
      if (added)
        try {
          await this.removeTransferred(lease.panel.panelId)
        } catch (removeError) {
          this.report('Transferred panel rollback failed', removeError)
        }
      try {
        if (this.panelCount() === 0) {
          await this.clearLayoutOrThrow()
          if (welcomeRemoved)
            this.openWelcome()
        } else
          await this.flushLayoutOrThrow()
      } catch (layoutError) {
        this.report('Transferred panel layout rollback failed', layoutError)
      }
      throw error
    } finally {
      this.receivingTransferCount -= 1
      if (this.receivingTransferCount === 0)
        this.notifyActivePanel()
    }
  }

  async closeOtherPanels(panelId: string): Promise<void> {
    const api = this.api
    if (!api)
      return
    // One at a time and each asked for itself: a refusal leaves that panel and takes the rest.
    for (const panel of TabsController.snapshotOf(api))
      if (panel.id !== panelId)
        await this.hidePanel(panel.id)
    api.getPanel(panelId)?.api.setActive()
  }

  toggleMaximizeActiveGroup(): void {
    const api = this.api
    if (!api)
      return
    if (api.hasMaximizedGroup())
      api.exitMaximizedGroup()
    else if (api.activePanel)
      api.maximizeGroup(api.activePanel)
  }

  async resetLayout(): Promise<void> {
    const api = this.api
    if (!api)
      return
    for (const panel of TabsController.snapshotOf(api))
      await this.hidePanel(panel.id)
    this.closedPanelParameters.clear()
    this.openWelcome()
  }

  /**
   * `failed` carries the main process's own read failure, so one latch covers both halves: a file
   * this side could not parse and a file the other side could not read.
   */
  private restoreLayout(saved: string | null, failed: boolean): void {
    const api = this.api
    if (!api)
      return
    if (failed) {
      this.restoreFailed = true
      this.ports.reportError('Saved layout could not be read; this session will not overwrite it')
      this.openWelcome()
      return
    }
    if (!saved) {
      this.openWelcome()
      return
    }
    try {
      api.fromJSON(JSON.parse(saved) as SerializedDockview)
      this.persistedLayout = saved
      return
    } catch (error) {
      this.restoreFailed = true
      this.ports.reportError(
        `Layout restore failed; saved data was preserved: ${ErrorText.of(error)}`,
      )
      this.openWelcome()
    }
  }

  async restoreAndReconcile(saved: string | null, failed: boolean): Promise<void> {
    this.restoreLayout(saved, failed)
    if (this.restoreFailed) {
      this.indexReady = true
      await this.ports.setActivePanel(null)
      return
    }
    const answer = await this.ports.reconcilePanels(this.inventoryWithoutWelcome())
    for (const panelId of answer.rejectedPanelIds)
      await this.hidePanel(panelId, { silent: true })
    if (this.inventoryWithoutWelcome().length === 0) {
      this.removeWelcomeSilently()
      await this.clearLayoutOrThrow()
      this.openWelcome()
    } else if (answer.rejectedPanelIds.length > 0)
      await this.flushLayoutOrThrow()
    this.indexReady = true
    await this.ports.setActivePanel(this.indexedActivePanelId())
  }

  panelCount(): number {
    return this.api?.panels.length ?? 0
  }

  removeWelcomeSilently(): void {
    const api = this.api
    if (!api)
      return
    for (const panel of TabsController.snapshotOf(api))
      if (panel.view.contentComponent === PanelKeysConst.welcome)
        api.removePanel(panel)
  }

  async flushLayoutOrThrow(): Promise<void> {
    this.cancelPendingSave()
    if (this.restoreFailed)
      throw new Error('Layout writes are disabled after a failed restore')
    for (;;) {
      if (this.panelCount() === 0)
        throw new Error('Empty layout requires clearLayoutOrThrow')
      const api = this.requireApi()
      const serialized = JSON.stringify(api.toJSON())
      await this.enqueueWrite({ kind: 'save', layout: serialized })
      if (JSON.stringify(api.toJSON()) === serialized)
        return
    }
  }

  async clearLayoutOrThrow(): Promise<void> {
    this.cancelPendingSave()
    if (this.panelCount() !== 0)
      throw new Error('Cannot clear a non-empty workspace')
    if (this.restoreFailed)
      throw new Error('Layout writes are disabled after a failed restore')
    await this.enqueueWrite({ kind: 'clear' })
  }

  dispose(): void {
    this.releaseSubscriptions()
    if (this.saveTimer) {
      this.cancelPendingSave()
      this.persist()
    }
  }

  /** Every subscription goes together, whichever way this controller lets go of its api. */
  private releaseSubscriptions(): void {
    for (const subscription of this.subscriptions)
      subscription.dispose()
    this.subscriptions = []
  }

  private scheduleSave(): void {
    if (this.restoreFailed || !this.api)
      return
    if (this.saveTimer)
      clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persist()
    }, WorkspaceSaveLimits.debounceMilliseconds)
  }

  /**
   * The latch is read here rather than only where the timer is armed: a restore that fails while a
   * save is already pending must stop that save too, not only the ones scheduled after it.
   */
  private persist(): void {
    const api = this.api
    if (!api || this.restoreFailed)
      return
    // A workspace with no panels in it is never worth what it would replace. dockview empties
    // itself when it is torn down - a window closing, a dev-server reload, a remount - and it does
    // so while this subscription is still live, so the last thing written would be the emptiness of
    // the teardown. That is how a real workspace was lost here on 2026-08-03: three groups survived
    // in the grid with not one view left in them. Closing every tab by hand lands in the same shape
    // and costs one click to rebuild; the stored layout is worth more than that.
    if (api.panels.length === 0) {
      this.reportEmptyRefusal()
      return
    }
    if (this.hasOnlyWelcome())
      return
    const serialized = JSON.stringify(api.toJSON())
    // `fromJSON` emits a layout change of its own, so without this every start writes back the
    // layout it has just restored and spends one of the ten recovery points on a byte-identical copy.
    if (serialized === this.persistedLayout)
      return
    void this.enqueueWrite({ kind: 'save', layout: serialized })
      .then(() => {
        if (this.api && JSON.stringify(this.api.toJSON()) !== serialized)
          this.persist()
      })
      .catch((error: unknown) => this.report('Layout could not be stored', error))
  }

  private enqueueWrite(write: LayoutWrite): Promise<void> {
    const operation = this.writeTail.catch(() => undefined).then(async () => {
      if (write.kind === 'save' && write.layout === this.persistedLayout)
        return
      const stored = write.kind === 'save'
        ? await this.ports.saveLayout(write.layout)
        : await this.ports.clearLayout()
      if (!stored)
        throw new Error(`The main process refused layout ${write.kind}`)
      this.persistedLayout = write.kind === 'save' ? write.layout : null
    })
    this.writeTail = operation
    return operation
  }

  private cancelPendingSave(): void {
    if (this.saveTimer)
      clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  /** Once per session: a teardown fires this on every panel it removes. */
  private reportEmptyRefusal(): void {
    if (this.emptyRefusalReported)
      return
    this.emptyRefusalReported = true
    this.ports.reportError('Refusing to store an empty workspace; the saved layout was kept')
  }

  private inventoryWithoutWelcome(): readonly WorkspacePanelPresence[] {
    const api = this.requireApi()
    return api.panels
      .filter((panel) => panel.view.contentComponent !== PanelKeysConst.welcome)
      .map((panel) => this.presenceOf(
        panel.view.contentComponent,
        panel.title ?? this.ports.registry.titleOf(panel.view.contentComponent),
        { ...panel.params },
        panel.id,
      ))
  }

  private presenceOf(
    key: string,
    title: string,
    params: Record<string, unknown>,
    panelId = TabsController.panelIdOf(key, params),
  ): WorkspacePanelPresence {
    let sessionId: string | null = null
    let presentation: WorkspacePanelPresence['presentation'] = null
    if (key === PanelKeysConst.terminal) {
      const reading = TerminalTargetCodec.read(params)
      if (reading === null)
        throw new Error(`A terminal panel requires a valid target: ${JSON.stringify(params)}`)
      if (reading.target.kind === 'local') {
        sessionId = reading.target.sessionId
        if (reading.presentation === 'session') presentation = 'session'
        else if (reading.presentation === 'tab') presentation = 'plain'
        else
          throw new Error(`Unknown terminal presentation: ${JSON.stringify(reading.presentation)}`)
      } else if (reading.target.kind === 'remote') return {
        panelId,
        key,
        title,
        params: { ...params },
        sessionId: null,
        presentation: null,
      }
      else
        throw new Error(`Unknown terminal target: ${JSON.stringify(reading.target)}`)
    }
    return { panelId, key, title, params: { ...params }, sessionId, presentation }
  }

  private indexedActivePanelId(): string | null {
    const panel = this.api?.activePanel
    if (!panel || panel.view.contentComponent === PanelKeysConst.welcome)
      return null
    return panel.id
  }

  private requireApi(): DockviewApi {
    if (!this.api)
      throw new Error('Tabs controller is not attached')
    return this.api
  }

  private report(prefix: string, error: unknown): void {
    this.ports.reportError(`${prefix}: ${ErrorText.of(error)}`)
  }

  private static positionOf(direction: MoveDirection): 'left' | 'right' | 'top' | 'bottom' {
    if (direction === 'right')
      return 'right'
    else if (direction === 'below')
      return 'bottom'
    else if (direction === 'left')
      return 'left'
    else if (direction === 'above')
      return 'top'
    else
      throw new Error(`Unknown move direction: ${JSON.stringify(direction)}`)
  }

  /** The laid-out boxes, which is the only thing the search needs and the only thing dockview has. */
  private static neighbourOf(
    current: DockviewGroupPanel,
    direction: MoveDirection,
    groups: readonly DockviewGroupPanel[],
  ): DockviewGroupPanel | null {
    const boxOf = (group: DockviewGroupPanel): TabGroupBox => {
      const rect = group.element.getBoundingClientRect()
      return { id: group.id, left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    }
    const found = TabGroupNeighbour.nearest(boxOf(current), direction, groups.map(boxOf))
    return found === null ? null : groups.find((group) => group.id === found.id) ?? null
  }

  static placementOf(event: DockviewDidDropEvent): TabDropPlacement {
    if (event.panel && event.group) {
      const index = event.group.panels.indexOf(event.panel)
      if (index < 0)
        throw new Error(`Dockview drop panel is absent from group: ${event.panel.id}`)
      return { kind: 'tab', referencePanelId: event.panel.id, index }
    } else if (event.group && event.position === 'center')
      return { kind: 'group', referenceGroupId: event.group.id }
    else if (event.group && TabsController.isEdge(event.position))
      return {
        kind: 'split',
        referenceGroupId: event.group.id,
        direction: TabsController.directionOf(event.position),
      }
    else if (!event.group && event.position === 'center')
      return { kind: 'empty' }
    else if (!event.group && TabsController.isEdge(event.position))
      return {
        kind: 'split',
        referenceGroupId: null,
        direction: TabsController.directionOf(event.position),
      }
    else
      throw new Error(`Unknown dockview drop: ${JSON.stringify(event.position)}`)
  }

  private static addPositionOf(placement: TabDropPlacement): AddPanelPositionOptions | undefined {
    if (placement.kind === 'tab')
      return { referencePanel: placement.referencePanelId, index: placement.index }
    else if (placement.kind === 'group')
      return { referenceGroup: placement.referenceGroupId }
    else if (placement.kind === 'split' && placement.referenceGroupId !== null)
      return {
        referenceGroup: placement.referenceGroupId,
        direction: placement.direction,
      }
    else if (placement.kind === 'split' && placement.referenceGroupId === null)
      return { direction: placement.direction }
    else if (placement.kind === 'empty')
      return undefined
    else
      throw new Error(`Unknown tab drop placement: ${JSON.stringify(placement)}`)
  }

  private static isEdge(position: DockviewDidDropEvent['position']): boolean {
    if (position === 'top' || position === 'bottom'
      || position === 'left' || position === 'right')
      return true
    else if (position === 'center')
      return false
    else
      throw new Error(`Unknown dockview drop position: ${JSON.stringify(position)}`)
  }

  private static directionOf(
    position: DockviewDidDropEvent['position'],
  ): Extract<TabDropPlacement, { kind: 'split' }>['direction'] {
    if (position === 'top')
      return 'above'
    else if (position === 'bottom')
      return 'below'
    else if (position === 'left')
      return 'left'
    else if (position === 'right')
      return 'right'
    else if (position === 'center')
      throw new Error('A center drop has no split direction')
    else
      throw new Error(`Unknown dockview edge: ${JSON.stringify(position)}`)
  }

  /** Removal mutates the list the api hands back, so every close loop walks a copy of it. */
  private static snapshotOf(api: DockviewApi): IDockviewPanel[] {
    return [...api.panels]
  }
}
