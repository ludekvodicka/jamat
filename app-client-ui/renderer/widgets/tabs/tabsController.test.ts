import { PanelKeysConst } from '../../../shared/tabTransfer'
import type {
  AddPanelPositionOptions,
  DockviewApi,
  DockviewDidDropEvent,
  DockviewIDisposable,
  IDockviewPanelProps,
} from 'dockview'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ClaimPanelResult,
  ReconcilePanelsResult,
  TabDropPlacement,
  TabMoveTarget,
  TabTransferLease,
  TabTransferPayload,
  WorkspacePanelPresence,
} from '../../../shared/tabTransfer'
import { TerminalTargetCodec } from '../../../shared/terminalTarget'
import type { PanelOpenOutcome } from '../../shell/appShell.types'
import { PanelRegistry } from './panelRegistry'
import { TabsController } from './tabsController'

interface FakeGroup {
  id: string
  panels: FakePanel[]
  /** Where the group sits, which is the only thing the direction search reads off dockview. */
  element: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }
  bounds: { left: number; top: number; width: number; height: number }
}

interface FakeMove {
  panelId: string
  groupId: string
  position: string
}

interface FakePanel {
  id: string
  title: string
  group: FakeGroup
  params: Record<string, unknown>
  /** Where dockview keeps the panel's component key, and where the close hook reads it from. */
  view: { contentComponent: string }
  api: {
    setActive(): void
    setTitle(title: string): void
    moveTo(options: { group?: FakeGroup; position?: string }): void
    /** The real one merges the parameters and reaches the group model, which fires a layout change. */
    updateParameters(params: Record<string, unknown>): void
  }
}

interface FakeAddOptions {
  inactive?: boolean
  id: string
  component: string
  title: string
  params: Record<string, unknown>
  position?: AddPanelPositionOptions
}

class FakeDataTransfer {
  effectAllowed = 'uninitialized'
  private readonly values = new Map<string, string>()

  get types(): readonly string[] {
    return [...this.values.keys()]
  }

  getData(format: string): string {
    return this.values.get(format) ?? ''
  }

  setData(format: string, data: string): void {
    this.values.set(format, data)
  }
}

/**
 * The slice of DockviewApi the controller drives, with real enough grouping that the split guard and
 * the neighbour activation are answered by the model rather than by the assertion.
 */
class FakeDockview {
  readonly added: FakeAddOptions[] = []
  readonly activated: string[] = []
  readonly removed: string[] = []
  readonly restored: string[] = []
  readonly moved: FakeMove[] = []
  readonly maximized: string[] = []
  readonly retitled: { panelId: string; title: string }[] = []
  /**
   * Serializes what the fake HOLDS. A constant here made an empty workspace serialize exactly like
   * a full one, so the dedupe swallowed the write and the zero-panel guard could be deleted with
   * every test still green.
   */
  serialized(): string {
    return JSON.stringify(this.toJSON())
  }

  private layoutListeners: (() => void)[] = []
  /**
   * How many times the controller let go of a layout listener on this api. Releasing one TWICE is
   * harmless here and is not harmless in the controller: it means the released subscription is
   * still in the list it was released from, so the list grows by seven on every re-attach.
   */
  layoutDisposeCalls = 0
  private activePanelListeners: (() => void)[] = []
  private removedPanelListeners: ((panel: FakePanel) => void)[] = []
  private dragPanelListeners: ((event: {
    panel: FakePanel
    nativeEvent: { dataTransfer: FakeDataTransfer | null }
  }) => void)[] = []
  private dragOverListeners: ((event: {
    nativeEvent: { dataTransfer: FakeDataTransfer | null }
    accept(): void
  }) => void)[] = []
  private dropListeners: ((event: DockviewDidDropEvent) => void)[] = []
  private movePanelListeners: ((event: { panel: FakePanel; from: FakeGroup }) => void)[] = []
  private groupList: FakeGroup[] = []
  private activeId: string | null = null
  private maximizedGroup = false
  private nextGroupNumber = 0
  addFailure: Error | null = null

  constructor(private readonly restoreThrows = false) {}

  asApi(): DockviewApi {
    return this as unknown as DockviewApi
  }

  get panels(): FakePanel[] {
    return this.groupList.flatMap((group) => group.panels)
  }

  get groups(): FakeGroup[] {
    return this.groupList
  }

  get activePanel(): FakePanel | undefined {
    return this.panels.find((panel) => panel.id === this.activeId)
  }

  /** dockview's own answer: the group holding the panel in front. */
  get activeGroup(): FakeGroup | undefined {
    return this.activePanel?.group
  }

  getPanel(id: string): FakePanel | undefined {
    return this.panels.find((panel) => panel.id === id)
  }

  addPanel(options: FakeAddOptions): FakePanel {
    if (this.addFailure)
      throw this.addFailure
    this.added.push(options)
    const position = options.position
    let group: FakeGroup
    if (position && 'referencePanel' in position) {
      const reference = typeof position.referencePanel === 'string'
        ? this.getPanel(position.referencePanel)
        : position.referencePanel as unknown as FakePanel
      if (!reference)
        throw new Error(`Unknown fake reference panel: ${String(position.referencePanel)}`)
      group = position.direction === undefined ? reference.group : this.createGroup()
    } else if (position && 'referenceGroup' in position) {
      const referenceId = typeof position.referenceGroup === 'string'
        ? position.referenceGroup
        : position.referenceGroup.id
      const reference = this.groupList.find((candidate) => candidate.id === referenceId)
      if (!reference)
        throw new Error(`Unknown fake reference group: ${referenceId}`)
      group = position.direction === undefined ? reference : this.createGroup()
    } else if (position && 'direction' in position)
      group = this.createGroup()
    else
      group = this.activePanel?.group ?? this.groupList[0] ?? this.createGroup()
    const panel = this.createPanel(options.id, group, options.component, options.title)
    panel.params = { ...options.params }
    const index = position && 'index' in position ? position.index : undefined
    if (index === undefined)
      group.panels.push(panel)
    else
      group.panels.splice(index, 0, panel)
    if (!options.inactive) {
      this.activeId = panel.id
      this.emitActivePanelChange()
    }
    this.emitLayoutChange()
    return panel
  }

  removePanel(panel: FakePanel): void {
    this.removed.push(panel.id)
    panel.group.panels = panel.group.panels.filter((candidate) => candidate.id !== panel.id)
    this.groupList = this.groupList.filter((group) => group.panels.length > 0)
    if (this.activeId === panel.id) {
      this.activeId = this.panels[0]?.id ?? null
      this.emitActivePanelChange()
    }
    for (const listener of [...this.removedPanelListeners])
      listener(panel)
    this.emitLayoutChange()
  }

  fromJSON(layout: unknown): void {
    if (this.restoreThrows)
      throw new Error('unknown panel key')
    this.restored.push(JSON.stringify(layout))
  }

  toJSON(): { grid: { id: string; params: Record<string, unknown> }[] } {
    return { grid: this.panels.map((panel) => ({ id: panel.id, params: panel.params })) }
  }

  /** Returns dockview's own disposable, so a controller that keeps two of them is visible here. */
  onDidLayoutChange(listener: () => void): DockviewIDisposable {
    this.layoutListeners.push(listener)
    return {
      dispose: () => {
        this.layoutDisposeCalls += 1
        this.layoutListeners = this.layoutListeners.filter((candidate) => candidate !== listener)
      },
    }
  }

  get layoutListenerCount(): number {
    return this.layoutListeners.length
  }

  /** The real one is its own event, fired wherever the panel in front changes. */
  onDidActivePanelChange(listener: () => void): DockviewIDisposable {
    this.activePanelListeners.push(listener)
    return {
      dispose: () => {
        this.activePanelListeners = this.activePanelListeners
          .filter((candidate) => candidate !== listener)
      },
    }
  }

  onDidRemovePanel(listener: (panel: FakePanel) => void): DockviewIDisposable {
    this.removedPanelListeners.push(listener)
    return {
      dispose: () => {
        this.removedPanelListeners = this.removedPanelListeners
          .filter((candidate) => candidate !== listener)
      },
    }
  }

  onWillDragPanel(listener: (event: {
    panel: FakePanel
    nativeEvent: { dataTransfer: FakeDataTransfer | null }
  }) => void): DockviewIDisposable {
    this.dragPanelListeners.push(listener)
    return {
      dispose: () => {
        this.dragPanelListeners = this.dragPanelListeners
          .filter((candidate) => candidate !== listener)
      },
    }
  }

  onUnhandledDragOverEvent(listener: (event: {
    nativeEvent: { dataTransfer: FakeDataTransfer | null }
    accept(): void
  }) => void): DockviewIDisposable {
    this.dragOverListeners.push(listener)
    return {
      dispose: () => {
        this.dragOverListeners = this.dragOverListeners
          .filter((candidate) => candidate !== listener)
      },
    }
  }

  onDidDrop(listener: (event: DockviewDidDropEvent) => void): DockviewIDisposable {
    this.dropListeners.push(listener)
    return {
      dispose: () => {
        this.dropListeners = this.dropListeners.filter((candidate) => candidate !== listener)
      },
    }
  }

  onDidMovePanel(listener: (event: { panel: FakePanel; from: FakeGroup }) => void): DockviewIDisposable {
    this.movePanelListeners.push(listener)
    return {
      dispose: () => {
        this.movePanelListeners = this.movePanelListeners
          .filter((candidate) => candidate !== listener)
      },
    }
  }

  get removedPanelListenerCount(): number {
    return this.removedPanelListeners.length
  }

  get movePanelListenerCount(): number {
    return this.movePanelListeners.length
  }

  get activePanelListenerCount(): number {
    return this.activePanelListeners.length
  }

  get transferListenerCount(): number {
    return this.dragPanelListeners.length + this.dragOverListeners.length + this.dropListeners.length
  }

  /**
   * Every listener the controller holds on this api, of whatever kind. One number, because the rule
   * is about the whole SET: the controller used to keep seven fields and release them in two places,
   * so an eighth event added to one and forgotten in the other would keep firing into a controller
   * nobody holds any more.
   */
  get listenerCount(): number {
    return this.layoutListeners.length + this.activePanelListeners.length
      + this.removedPanelListeners.length + this.movePanelListeners.length
      + this.transferListenerCount
  }

  hasMaximizedGroup(): boolean {
    return this.maximizedGroup
  }

  maximizeGroup(panel: FakePanel): void {
    this.maximizedGroup = true
    this.maximized.push(panel.id)
  }

  exitMaximizedGroup(): void {
    this.maximizedGroup = false
    this.maximized.push('exit')
  }

  /** Seeds panels the way a restored layout would: named groups, one named panel active. */
  seed(groups: readonly (readonly string[])[], activeId: string): void {
    for (const panelIds of groups) {
      const group = this.createGroup()
      for (const panelId of panelIds)
        group.panels.push(this.createPanel(panelId, group))
    }
    this.activeId = activeId
  }

  seedPanel(
    id: string,
    component: string,
    title: string,
    params: Record<string, unknown>,
  ): void {
    const group = this.groupList[0] ?? this.createGroup()
    const panel = this.createPanel(id, group, component, title)
    panel.params = { ...params }
    group.panels.push(panel)
    this.activeId = id
  }

  emitLayoutChange(): void {
    for (const listener of [...this.layoutListeners])
      listener()
  }

  emitWillDragPanel(panelId: string, dataTransfer: FakeDataTransfer | null): void {
    const panel = this.getPanel(panelId)
    if (!panel)
      throw new Error(`Unknown fake dragged panel: ${panelId}`)
    for (const listener of [...this.dragPanelListeners])
      listener({ panel, nativeEvent: { dataTransfer } })
  }

  emitUnhandledDragOver(dataTransfer: FakeDataTransfer | null): boolean {
    let accepted = false
    for (const listener of [...this.dragOverListeners])
      listener({
        nativeEvent: { dataTransfer },
        accept: () => { accepted = true },
      })
    return accepted
  }

  emitDrop(event: DockviewDidDropEvent): void {
    for (const listener of [...this.dropListeners])
      listener(event)
  }

  /** What dockview fires once a panel has actually landed somewhere, drag or programmatic move. */
  emitMovePanel(panelId: string): void {
    const panel = this.getPanel(panelId)
    if (!panel)
      throw new Error(`Unknown fake moved panel: ${panelId}`)
    for (const listener of [...this.movePanelListeners])
      listener({ panel, from: panel.group })
  }

  private emitActivePanelChange(): void {
    for (const listener of [...this.activePanelListeners])
      listener()
  }

  private createGroup(): FakeGroup {
    const bounds = { left: 0, top: 0, width: 100, height: 100 }
    const group: FakeGroup = {
      id: `group-${this.nextGroupNumber++}`,
      panels: [],
      bounds,
      element: { getBoundingClientRect: () => group.bounds },
    }
    this.groupList.push(group)
    return group
  }

  /** Lays a seeded group out, for the moves that ask which group is over there. */
  place(groupId: string, bounds: { left: number; top: number; width: number; height: number }): void {
    const group = this.groupList.find((candidate) => candidate.id === groupId)
    if (!group)
      throw new Error(`Unknown fake group: ${groupId}`)
    group.bounds = bounds
  }

  private createPanel(
    id: string,
    group: FakeGroup,
    component = 'probe',
    title = id,
  ): FakePanel {
    const panel: FakePanel = {
      id,
      title,
      group,
      params: {},
      view: { contentComponent: component },
      api: {
        setActive: () => {
          this.activated.push(id)
          this.activeId = id
          this.emitActivePanelChange()
        },
        setTitle: (value) => {
          panel.title = value
          this.retitled.push({ panelId: id, title: value })
        },
        updateParameters: (params) => {
          panel.params = { ...panel.params, ...params }
          this.emitLayoutChange()
        },
        moveTo: (options) => this.moved.push({
          panelId: id,
          groupId: options.group?.id ?? 'none',
          position: options.position ?? 'none',
        }),
      },
    }
    return panel
  }
}

class TabsControllerHarness {
  readonly saved: string[] = []
  readonly cleared: string[] = []
  readonly claimed: WorkspacePanelPresence[] = []
  readonly reconciled: (readonly WorkspacePanelPresence[])[] = []
  readonly released: string[] = []
  readonly active: (string | null)[] = []
  readonly errors: string[] = []
  readonly dragged: { token: string; panel: TabTransferPayload }[] = []
  readonly prepared: string[] = []
  readonly committed: string[] = []
  readonly aborted: string[] = []
  readonly moved: { panel: TabTransferPayload; target: TabMoveTarget }[] = []
  readonly transferSequence: string[] = []
  /** Flipped by the test that checks a refused write is not remembered as stored. */
  storeAccepts = true
  clearAccepts = true
  claimAnswer: ClaimPanelResult = { kind: 'granted' }
  reconcileAnswer: ReconcilePanelsResult | null = null
  saveOperation: ((layout: string) => Promise<boolean>) | null = null
  clearOperation: (() => Promise<boolean>) | null = null
  transferLease: TabTransferLease | null = null
  transferCommitError: Error | null = null
  /** What the close hook was asked about, and what it answers. */
  readonly asked: { key: string; params: Record<string, unknown> }[] = []
  allowsClose = true
  readonly controller: TabsController

  constructor(readonly dockview: FakeDockview) {
    const registry = new PanelRegistry()
    for (const key of [PanelKeysConst.welcome, PanelKeysConst.probe, PanelKeysConst.terminal] as const)
      registry.register({
        key,
        title: key === PanelKeysConst.welcome ? 'Home' : 'Lifecycle Probe',
        component: (() => null) as unknown as React.FunctionComponent<IDockviewPanelProps>,
      })
    this.controller = new TabsController({
      registry,
      saveLayout: (layout) => {
        this.saved.push(layout)
        this.transferSequence.push('save')
        return this.saveOperation?.(layout) ?? Promise.resolve(this.storeAccepts)
      },
      clearLayout: () => {
        this.cleared.push('clear')
        this.transferSequence.push('clear')
        return this.clearOperation?.() ?? Promise.resolve(this.clearAccepts)
      },
      claimPanel: (panel) => {
        this.claimed.push(panel)
        return Promise.resolve(this.claimAnswer)
      },
      reconcilePanels: (panels) => {
        this.reconciled.push(panels)
        return Promise.resolve(this.reconcileAnswer ?? {
          acceptedPanelIds: panels.map((panel) => panel.panelId),
          rejectedPanelIds: [],
        })
      },
      releasePanel: (panelId) => { this.released.push(panelId); return Promise.resolve() },
      setActivePanel: (panelId) => { this.active.push(panelId); return Promise.resolve() },
      tabDragStarted: (token, panel) => {
        this.dragged.push({ token, panel })
        return Promise.resolve()
      },
      transferPrepare: (token) => {
        this.prepared.push(token)
        this.transferSequence.push('prepare')
        return Promise.resolve(this.transferLease)
      },
      transferCommit: (token) => {
        this.committed.push(token)
        this.transferSequence.push('commit')
        return this.transferCommitError === null
          ? Promise.resolve()
          : Promise.reject(this.transferCommitError)
      },
      transferAbort: (token) => {
        this.aborted.push(token)
        this.transferSequence.push('abort')
        return Promise.resolve()
      },
      movePanel: (panel, target) => {
        this.moved.push({ panel, target })
        return Promise.resolve()
      },
      reportError: (message) => this.errors.push(message),
      onWillUserClose: (key, params) => {
        this.asked.push({ key, params })
        return Promise.resolve(this.allowsClose)
      },
    })
    this.controller.attach(dockview.asApi())
  }

  static fresh(): TabsControllerHarness {
    return new TabsControllerHarness(new FakeDockview())
  }

  static failing(): TabsControllerHarness {
    return new TabsControllerHarness(new FakeDockview(true))
  }
}

describe('app-client-ui/renderer/widgets/tabs/tabsController', () => {
  it('preserves the active panel when opening and reopening an inactive review session', async () => {
    const h = TabsControllerHarness.fresh()
    await h.controller.openPanel(PanelKeysConst.probe, 'Current', {}, 'current')
    await h.controller.openPanel(PanelKeysConst.terminal, 'Review', { sessionId: 'review' }, 'review', { activate: false })
    expect(h.dockview.added.at(-1)).toMatchObject({ id: 'review', inactive: true })
    expect(h.controller.activePanelId()).toBe('current')
    await h.controller.openPanel(PanelKeysConst.terminal, 'Review', { sessionId: 'review' }, 'review', { activate: false })
    expect(h.controller.activePanelId()).toBe('current')
  })
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function settleWrites(): Promise<void> {
    for (let turn = 0; turn < 4; turn += 1)
      await Promise.resolve()
  }

  function dropEvent(
    dockview: FakeDockview,
    position: DockviewDidDropEvent['position'],
    panelId?: string,
    groupId?: string,
    dataTransfer: FakeDataTransfer | null = null,
  ): DockviewDidDropEvent {
    const panel = panelId === undefined ? undefined : dockview.getPanel(panelId)
    const group = groupId === undefined
      ? undefined
      : dockview.groups.find((candidate) => candidate.id === groupId)
    return {
      panel,
      group,
      position,
      nativeEvent: { dataTransfer },
    } as unknown as DockviewDidDropEvent
  }

  function placementOf(event: DockviewDidDropEvent): TabDropPlacement {
    return TabsController.placementOf(event)
  }

  function transferredPanel(
    panelId = 'probe:original-id',
    params: Record<string, unknown> = { serial: 1, sidebar: { width: 280 } },
  ): TabTransferPayload {
    return {
      panelId,
      key: 'probe',
      title: 'Transferred Probe',
      params,
      sessionId: null,
      presentation: null,
    }
  }

  it('registers a drag synchronously with both MIME forms and the exact current payload', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seedPanel(
      'probe:original-id',
      'probe',
      'Transferred Probe',
      { serial: 1, sidebar: { width: 280 } },
    )
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111')
    const dataTransfer = new FakeDataTransfer()

    harness.dockview.emitWillDragPanel('probe:original-id', dataTransfer)
    await settleWrites()

    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.getData('application/x-jamat-tab'))
      .toBe('11111111-1111-4111-8111-111111111111')
    expect(dataTransfer.getData('text/plain'))
      .toBe('jamat-tab:11111111-1111-4111-8111-111111111111')
    expect(harness.dragged).toEqual([{
      token: '11111111-1111-4111-8111-111111111111',
      panel: transferredPanel(),
    }])
  })

  it('never registers or accepts Home as a transferable panel', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seedPanel('welcome:{}', 'welcome', 'Home', {})
    const dataTransfer = new FakeDataTransfer()

    harness.dockview.emitWillDragPanel('welcome:{}', dataTransfer)
    await harness.controller.moveActivePanel({ kind: 'newWindow' })

    expect(harness.dragged).toEqual([])
    expect(harness.moved).toEqual([])
    expect(dataTransfer.types).toEqual([])
  })

  it('accepts recognized external drags and routes their drop through prepare', async () => {
    const harness = TabsControllerHarness.fresh()
    const payload = transferredPanel()
    harness.transferLease = { token: 'token-1', panel: payload }
    const dataTransfer = new FakeDataTransfer()
    dataTransfer.setData('application/x-jamat-tab', 'token-1')

    expect(harness.dockview.emitUnhandledDragOver(dataTransfer)).toBe(true)
    expect(harness.dockview.emitUnhandledDragOver(new FakeDataTransfer())).toBe(false)
    harness.dockview.emitDrop(dropEvent(harness.dockview, 'center', undefined, undefined, dataTransfer))
    await vi.waitFor(() => expect(harness.committed).toEqual(['token-1']))

    expect(harness.prepared).toEqual(['token-1'])
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual([payload.panelId])
  })

  it('normalizes every supported dockview drop target and rejects an unknown position', () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a', 'b']], 'a')
    const groupId = harness.dockview.groups[0]?.id
    if (groupId === undefined)
      throw new Error('The fake created no group')

    expect(placementOf(dropEvent(harness.dockview, 'center', 'b', groupId)))
      .toEqual({ kind: 'tab', referencePanelId: 'b', index: 1 })
    expect(placementOf(dropEvent(harness.dockview, 'center', undefined, groupId)))
      .toEqual({ kind: 'group', referenceGroupId: groupId })
    expect(placementOf(dropEvent(harness.dockview, 'top', undefined, groupId)))
      .toEqual({ kind: 'split', referenceGroupId: groupId, direction: 'above' })
    expect(placementOf(dropEvent(harness.dockview, 'bottom', undefined, groupId)))
      .toEqual({ kind: 'split', referenceGroupId: groupId, direction: 'below' })
    expect(placementOf(dropEvent(harness.dockview, 'left', undefined, groupId)))
      .toEqual({ kind: 'split', referenceGroupId: groupId, direction: 'left' })
    expect(placementOf(dropEvent(harness.dockview, 'right', undefined, groupId)))
      .toEqual({ kind: 'split', referenceGroupId: groupId, direction: 'right' })
    expect(placementOf(dropEvent(harness.dockview, 'center'))).toEqual({ kind: 'empty' })
    expect(placementOf(dropEvent(harness.dockview, 'right')))
      .toEqual({ kind: 'split', referenceGroupId: null, direction: 'right' })
    expect(() => placementOf(dropEvent(
      harness.dockview,
      'diagonal' as DockviewDidDropEvent['position'],
    ))).toThrow(/Unknown dockview drop position/)
  })

  it('adds a transferred panel under its payload id with its live parameters', () => {
    const harness = TabsControllerHarness.fresh()
    const payload = transferredPanel('probe:stable-id', {
      serial: 1,
      sidebar: { visible: true, width: 360 },
    })

    harness.controller.addTransferredPanel(payload, { kind: 'empty' })

    expect(harness.dockview.added).toEqual([{
      id: 'probe:stable-id',
      component: 'probe',
      title: 'Transferred Probe',
      params: { serial: 1, sidebar: { visible: true, width: 360 } },
    }])
    expect(harness.controller.transferPayload('probe:stable-id')).toEqual(payload)
  })

  it('maps tab, group and split placements onto the public addPanel API', () => {
    const tab = TabsControllerHarness.fresh()
    tab.dockview.seed([['a', 'b']], 'a')
    tab.controller.addTransferredPanel(transferredPanel(), {
      kind: 'tab',
      referencePanelId: 'b',
      index: 1,
    })
    expect(tab.dockview.added[0]?.position).toEqual({ referencePanel: 'b', index: 1 })

    const group = TabsControllerHarness.fresh()
    group.dockview.seed([['a']], 'a')
    const groupId = group.dockview.groups[0]?.id
    if (groupId === undefined)
      throw new Error('The fake created no group')
    group.controller.addTransferredPanel(transferredPanel(), {
      kind: 'group',
      referenceGroupId: groupId,
    })
    expect(group.dockview.added[0]?.position).toEqual({ referenceGroup: groupId })

    const split = TabsControllerHarness.fresh()
    split.controller.addTransferredPanel(transferredPanel(), {
      kind: 'split',
      referenceGroupId: null,
      direction: 'right',
    })
    expect(split.dockview.added[0]?.position).toEqual({ direction: 'right' })
  })

  it('flushes the target before commit and removes a solitary Home before durability', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.restoreAndReconcile(null, false)
    harness.saved.length = 0
    harness.cleared.length = 0
    harness.active.length = 0
    harness.transferSequence.length = 0
    const payload = transferredPanel()
    harness.transferLease = { token: 'token-1', panel: payload }

    await harness.controller.receiveTransfer('token-1', { kind: 'empty' })

    expect(harness.transferSequence).toEqual(['prepare', 'save', 'commit'])
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual([payload.panelId])
    expect(harness.saved).toHaveLength(1)
    expect(harness.saved[0]).not.toContain('welcome:{}')
    expect(harness.committed).toEqual(['token-1'])
    expect(harness.aborted).toEqual([])
    expect(harness.active).toEqual([payload.panelId])
  })

  it('aborts a refused target flush, removes the copy and restores Home after clear', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.restoreAndReconcile(null, false)
    harness.saved.length = 0
    harness.cleared.length = 0
    harness.asked.length = 0
    harness.transferSequence.length = 0
    harness.storeAccepts = false
    const payload = transferredPanel()
    harness.transferLease = { token: 'token-1', panel: payload }

    await expect(harness.controller.receiveTransfer('token-1', { kind: 'empty' }))
      .rejects.toThrow(/refused layout save/)
    vi.runAllTimers()
    await settleWrites()

    expect(harness.transferSequence).toEqual(['prepare', 'save', 'abort', 'clear'])
    expect(harness.committed).toEqual([])
    expect(harness.aborted).toEqual(['token-1'])
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual(['welcome:{}'])
    expect(harness.cleared).toEqual(['clear'])
    expect(harness.saved[0]).not.toContain('welcome:{}')
    expect(harness.saved).toHaveLength(1)
    expect(harness.asked).toEqual([])
  })

  it('rolls back a durable target copy when commit rejects a closing target', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.restoreAndReconcile(null, false)
    harness.saved.length = 0
    harness.cleared.length = 0
    harness.transferSequence.length = 0
    const payload = transferredPanel()
    harness.transferLease = { token: 'token-1', panel: payload }
    harness.transferCommitError = new Error('target is closing')

    await expect(harness.controller.receiveTransfer('token-1', { kind: 'empty' }))
      .rejects.toThrow(/target is closing/)

    expect(harness.transferSequence).toEqual(['prepare', 'save', 'commit', 'abort', 'clear'])
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual(['welcome:{}'])
    expect(harness.cleared).toEqual(['clear'])
  })

  it('removes a transferred plain tab silently without invoking its user-close hook', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seedPanel(
      'terminal:plain',
      'terminal',
      'Plain',
      { sessionId: 'session-1', presentation: 'tab' },
    )

    await harness.controller.removeTransferred('terminal:plain')

    expect(harness.asked).toEqual([])
    expect(harness.dockview.panels).toEqual([])
  })

  it('moves a non-welcome active panel through the command port', async () => {
    const harness = TabsControllerHarness.fresh()
    const payload = transferredPanel()
    harness.dockview.seedPanel(payload.panelId, payload.key, payload.title, payload.params)

    await harness.controller.moveActivePanel({ kind: 'newWindow' })

    expect(harness.moved).toEqual([{ panel: payload, target: { kind: 'newWindow' } }])
  })

  it('does not persist a solitary Home panel', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seedPanel('welcome:{}', 'welcome', 'Home', {})

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await settleWrites()

    expect(harness.saved).toEqual([])
  })

  it('restores a saved layout before reconciling its panels', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')

    await harness.controller.restoreAndReconcile('{"grid":{}}', false)
    expect(harness.dockview.restored).toEqual(['{"grid":{}}'])
    expect(harness.dockview.added).toEqual([])
  })

  it('opens Home when there is nothing saved yet', async () => {
    const harness = TabsControllerHarness.fresh()

    await harness.controller.restoreAndReconcile(null, false)
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual(['welcome:{}'])
  })

  // Scenario 1: the layout parsed on this side and dockview refused it.
  it('never overwrites a layout fromJSON failed to read', async () => {
    const harness = TabsControllerHarness.failing()

    await harness.controller.restoreAndReconcile('{"grid":{}}', false)
    expect(harness.errors.length).toBe(1)
    expect(harness.dockview.added.map((panel) => panel.id)).toEqual(['welcome:{}'])

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    harness.controller.dispose()

    expect(harness.saved).toEqual([])
  })

  // Scenario 2: the same latch, reached from the main process's own read failure.
  it('never overwrites a layout the main process could not read', async () => {
    const harness = TabsControllerHarness.fresh()

    await harness.controller.restoreAndReconcile(null, true)
    expect(harness.dockview.added.map((panel) => panel.id)).toEqual(['welcome:{}'])
    // The unreadable state is the user's problem too, so the latch says so instead of only latching.
    expect(harness.errors).toHaveLength(1)

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    harness.controller.dispose()

    expect(harness.saved).toEqual([])
  })

  it('does not reconcile or write after a failed restore, but publishes no active panel', async () => {
    const harness = TabsControllerHarness.fresh()

    await harness.controller.restoreAndReconcile(null, true)

    expect(harness.reconciled).toEqual([])
    expect(harness.saved).toEqual([])
    expect(harness.cleared).toEqual([])
    expect(harness.active).toEqual([null])
  })

  it('reconciles restored panel ids without deriving them again from mutated params', async () => {
    const harness = TabsControllerHarness.fresh()
    const panelId = 'terminal:{"sessionId":"s1"}'
    harness.dockview.seedPanel(panelId, 'terminal', 'Session One', { sessionId: 's1' })
    harness.dockview.getPanel(panelId)?.api.updateParameters({ sidebar: { width: 280 } })

    await harness.controller.restoreAndReconcile(harness.dockview.serialized(), false)

    expect(harness.reconciled).toEqual([[
      {
        panelId,
        key: 'terminal',
        title: 'Session One',
        params: { sessionId: 's1', sidebar: { width: 280 } },
        sessionId: 's1',
        presentation: 'session',
      },
    ]])
    expect(harness.active).toEqual([panelId])
  })

  it('filters Home from every restore inventory so separate windows do not collide', async () => {
    const first = TabsControllerHarness.fresh()
    const second = TabsControllerHarness.fresh()
    first.dockview.seedPanel('welcome:{}', 'welcome', 'Home', {})
    second.dockview.seedPanel('welcome:{}', 'welcome', 'Home', {})

    await first.controller.restoreAndReconcile(first.dockview.serialized(), false)
    await second.controller.restoreAndReconcile(second.dockview.serialized(), false)

    expect(first.reconciled).toEqual([[]])
    expect(second.reconciled).toEqual([[]])
    expect(first.claimed).toEqual([])
    expect(second.claimed).toEqual([])
    expect(first.dockview.panels.map((panel) => panel.id)).toEqual(['welcome:{}'])
    expect(second.dockview.panels.map((panel) => panel.id)).toEqual(['welcome:{}'])
  })

  it('clears a restored window whose only panel lost reconciliation, then opens Home', async () => {
    const harness = TabsControllerHarness.fresh()
    const panelId = 'terminal:{"sessionId":"duplicate"}'
    harness.dockview.seedPanel(panelId, 'terminal', 'Duplicate', { sessionId: 'duplicate' })
    harness.reconcileAnswer = { acceptedPanelIds: [], rejectedPanelIds: [panelId] }

    await harness.controller.restoreAndReconcile(harness.dockview.serialized(), false)

    expect(harness.dockview.removed).toEqual([panelId])
    expect(harness.cleared).toEqual(['clear'])
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual(['welcome:{}'])
  })

  // The latch used to be read only where the timer was armed, so a save already in flight ran anyway.
  it('drops a save that was already scheduled when the restore failed', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.emitLayoutChange()

    await harness.controller.restoreAndReconcile(null, true)
    vi.runAllTimers()

    expect(harness.saved).toEqual([])
  })

  it('saves a layout change once the burst settles', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"grid":{}}', false)

    harness.dockview.emitLayoutChange()
    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await settleWrites()

    expect(harness.saved).toEqual([harness.dockview.serialized()])
  })

  // Scenario 3: the last split before the window closes is the one the debounce would drop.
  it('flushes a pending save on dispose', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"grid":{}}', false)
    harness.dockview.emitLayoutChange()

    harness.controller.dispose()
    await settleWrites()

    expect(harness.saved).toEqual([harness.dockview.serialized()])
  })

  it('writes nothing on dispose when there is no pending change', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"grid":{}}', false)

    harness.controller.dispose()

    expect(harness.saved).toEqual([])
    expect(harness.errors).toEqual([])
  })

  // fromJSON emits a layout change of its own; every start used to write the layout it just read.
  // Seeded on purpose: with an empty workspace the zero-panel guard would answer instead of the
  // dedupe, and the test would pass without the line it exists for.
  it('writes nothing back when the restored layout serializes to what was read', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile(harness.dockview.serialized(), false)

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    harness.controller.dispose()

    expect(harness.saved).toEqual([])
    expect(harness.errors).toEqual([])
  })

  it('writes once for a burst that ends where the last write left the layout', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"grid":{}}', false)

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await settleWrites()
    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await settleWrites()

    expect(harness.saved).toEqual([harness.dockview.serialized()])
  })

  // A second attach on a live subscription is a second save of every change, and the second one wins.
  it('saves a change once after it was attached twice', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    harness.controller.attach(harness.dockview.asApi())

    expect(harness.dockview.layoutListenerCount).toBe(1)
    expect(harness.dockview.activePanelListenerCount).toBe(1)

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await settleWrites()

    expect(harness.saved).toEqual([harness.dockview.serialized()])
  })

  // 2026-08-03: a dev-server reload tore dockview down while this subscription was still live, and
  // the emptiness of the teardown replaced a workspace of four panels. Three groups survived in the
  // stored grid with not one view in them, which is a shape no click can produce.
  it('refuses to store a workspace with no panels in it', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"grid":{}}', false)
    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await settleWrites()
    expect(harness.saved).toHaveLength(1)

    await harness.controller.closeOtherPanels('a')
    await harness.controller.hidePanel('a')
    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    harness.controller.dispose()

    // Asserted on CONTENT, not on the count: the message alone was the only thing the old fake
    // could prove, and a persist that reported and then wrote anyway stayed green.
    expect(harness.saved).toHaveLength(1)
    expect(harness.saved[0]).toContain('"a"')
    expect(harness.saved.some((layout) => layout === JSON.stringify({ grid: [] }))).toBe(false)
    expect(harness.errors.some((message) => /empty workspace/.test(message))).toBe(true)
  })

  // The cursor used to move before the write, so a refused store was remembered as saved and the
  // same change was never offered again.
  it('keeps a refused layout pending instead of remembering it as stored', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"grid":{}}', false)
    harness.storeAccepts = false

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await vi.waitFor(() => expect(harness.saved).toHaveLength(1))

    harness.storeAccepts = true
    harness.dockview.emitLayoutChange()
    vi.runAllTimers()
    await vi.waitFor(() => expect(harness.saved).toHaveLength(2))
    expect(harness.saved[1]).toBe(harness.dockview.serialized())
  })

  it('serializes an A, B, A write burst in the order it was requested', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"baseline":true}', false)
    const pending: { layout: string; resolve(stored: boolean): void }[] = []
    harness.saveOperation = (layout) => new Promise<boolean>((resolve) => {
      pending.push({ layout, resolve })
    })

    harness.dockview.getPanel('a')?.api.updateParameters({ value: 'A' })
    vi.runAllTimers()
    await settleWrites()
    const layoutA = harness.dockview.serialized()
    harness.dockview.getPanel('a')?.api.updateParameters({ value: 'B' })
    vi.runAllTimers()
    await settleWrites()
    const layoutB = harness.dockview.serialized()
    harness.dockview.getPanel('a')?.api.updateParameters({ value: 'A' })
    vi.runAllTimers()
    await settleWrites()

    expect(pending.map((write) => write.layout)).toEqual([layoutA])
    pending[0]?.resolve(true)
    await settleWrites()
    expect(pending.map((write) => write.layout)).toEqual([layoutA, layoutB])
    pending[1]?.resolve(true)
    await settleWrites()
    expect(pending.map((write) => write.layout)).toEqual([layoutA, layoutB, layoutA])
    pending[2]?.resolve(true)
    await settleWrites()
  })

  it('waits for an unrelated write before flushing the newest stable layout', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"baseline":true}', false)
    const pending: { layout: string; resolve(stored: boolean): void }[] = []
    harness.saveOperation = (layout) => new Promise<boolean>((resolve) => {
      pending.push({ layout, resolve })
    })

    harness.dockview.getPanel('a')?.api.updateParameters({ value: 'A' })
    vi.runAllTimers()
    await settleWrites()
    harness.dockview.getPanel('a')?.api.updateParameters({ value: 'B' })
    let flushed = false
    const flush = harness.controller.flushLayoutOrThrow().then(() => { flushed = true })
    await settleWrites()

    expect(pending).toHaveLength(1)
    expect(flushed).toBe(false)
    pending[0]?.resolve(true)
    await settleWrites()
    expect(pending).toHaveLength(2)
    expect(flushed).toBe(false)
    pending[1]?.resolve(true)
    await flush
    expect(flushed).toBe(true)
  })

  it('throws when a durable flush is refused and retries the same layout later', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile('{"baseline":true}', false)
    harness.storeAccepts = false

    await expect(harness.controller.flushLayoutOrThrow()).rejects.toThrow(/refused layout save/)
    harness.storeAccepts = true
    await expect(harness.controller.flushLayoutOrThrow()).resolves.toBeUndefined()
    expect(harness.saved).toEqual([
      harness.dockview.serialized(),
      harness.dockview.serialized(),
    ])
  })

  it('keeps save and clear as separate guarded durable operations', async () => {
    const nonEmpty = TabsControllerHarness.fresh()
    nonEmpty.dockview.seed([['a']], 'a')
    await expect(nonEmpty.controller.clearLayoutOrThrow()).rejects
      .toThrow(/non-empty workspace/)

    const empty = TabsControllerHarness.fresh()
    await expect(empty.controller.flushLayoutOrThrow()).rejects
      .toThrow(/requires clearLayoutOrThrow/)
    await expect(empty.controller.clearLayoutOrThrow()).resolves.toBeUndefined()
    expect(empty.cleared).toEqual(['clear'])

    const failed = TabsControllerHarness.fresh()
    await failed.controller.restoreAndReconcile(null, true)
    await expect(failed.controller.flushLayoutOrThrow()).rejects.toThrow(/failed restore/)
    failed.controller.removeWelcomeSilently()
    await expect(failed.controller.clearLayoutOrThrow()).rejects.toThrow(/failed restore/)
  })

  it('explains the refusal once, not once per panel a teardown removes', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.restoreAndReconcile('{"grid":{}}', false)
    harness.controller.removeWelcomeSilently()

    for (let removal = 0; removal < 5; removal += 1) {
      harness.dockview.emitLayoutChange()
      vi.runAllTimers()
    }

    expect(harness.errors.filter((message) => /empty workspace/.test(message))).toHaveLength(1)
  })

  // The controller's half of the chain the tab sidebar persists through: a parameter write reaches
  // the group model, the group model fires a layout change, and the debounced save carries the
  // parameters. Which api the PANEL calls is pinned in panelSidebar.test.tsx, not here.
  it('saves the layout, parameters included, after a panel writes its own', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a']], 'a')
    await harness.controller.restoreAndReconcile(harness.dockview.serialized(), false)

    harness.dockview.getPanel('a')?.api.updateParameters({ sidebar: { visible: true, width: 220 } })
    vi.runAllTimers()

    await vi.waitFor(() => expect(harness.saved).toHaveLength(1))
    expect(harness.saved[0]).toContain('"width":220')
  })

  // The stated hazard: an id derived from the LIVE parameters would change on every splitter drag,
  // so the panel would stop answering to the id its own layout was saved under and a second open
  // would add a duplicate instead of activating it.
  it('reopens the panel it already has, even after its parameters changed', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.openPanel('probe', 'Lifecycle Probe 1', { serial: 1 })
    const panelId = TabsController.panelIdOf('probe', { serial: 1 })
    harness.dockview.getPanel(panelId)?.api.updateParameters({
      sidebar: { visible: true, width: 300 },
    })

    await harness.controller.openPanel('probe', 'Lifecycle Probe 1', { serial: 1 })

    expect(harness.dockview.added).toHaveLength(1)
    expect(harness.dockview.activated).toContain(panelId)
  })

  // For a caller that can name one thing two ways: it has to be able to ask before it opens.
  it('brings an existing panel forward and says it found one', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.openPanel('probe', 'Lifecycle Probe 1', { serial: 1 })
    const panelId = TabsController.panelIdOf('probe', { serial: 1 })

    expect(harness.controller.activatePanel(panelId)).toBe(true)
    expect(harness.dockview.added).toHaveLength(1)
    expect(harness.dockview.activated).toContain(panelId)
  })

  it('says it found nothing rather than opening one it was not asked to open', () => {
    const harness = TabsControllerHarness.fresh()

    expect(harness.controller.activatePanel(TabsController.panelIdOf('probe', { serial: 9 })))
      .toBe(false)
    expect(harness.dockview.added).toHaveLength(0)
  })

  it('applies external parameters to an existing panel without deriving another id', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.openPanel('probe', 'Probe', { serial: 1 })
    const panelId = TabsController.panelIdOf('probe', { serial: 1 })

    expect(harness.controller.applyPanelParameters(panelId, (params) => ({
      ...params,
      split: { active: 'document-one' },
    }))).toBe(true)
    expect(harness.controller.applyPanelParameters('missing', (params) => params)).toBe(false)
    expect(harness.dockview.getPanel(panelId)?.params).toEqual({
      serial: 1,
      split: { active: 'document-one' },
    })
    expect(harness.dockview.added.map((panel) => panel.id)).toEqual([panelId])
  })

  it('lets go of every listener on dispose, and of the old api when it attaches to a new one', () => {
    const harness = TabsControllerHarness.fresh()
    expect(harness.dockview.listenerCount).toBe(7)

    const second = new FakeDockview()
    harness.controller.attach(second.asApi())

    // The previous api's listeners go with it: two live sets would save every layout change twice.
    expect(harness.dockview.listenerCount).toBe(0)
    expect(second.listenerCount).toBe(7)

    harness.controller.dispose()

    expect(second.listenerCount).toBe(0)
    // Released once, not once per later release: the list is emptied when it is released, so a
    // re-attach does not carry the old api's subscriptions along beside the new ones.
    expect(harness.dockview.layoutDisposeCalls).toBe(1)
  })

  it('stops listening for layout changes once it is disposed', () => {
    const harness = TabsControllerHarness.fresh()
    harness.controller.dispose()

    expect(harness.dockview.layoutListenerCount).toBe(0)
    expect(harness.dockview.activePanelListenerCount).toBe(0)
    expect(harness.dockview.removedPanelListenerCount).toBe(0)

    harness.dockview.emitLayoutChange()
    vi.runAllTimers()

    expect(harness.saved).toEqual([])
  })

  it('derives one panel id per thing, so reopening finds the same panel', () => {
    expect(TabsController.panelIdOf('probe', {})).toBe('probe:{}')
    expect(TabsController.panelIdOf('probe', { seat: 2 })).toBe('probe:{"seat":2}')
  })

  // Scenario 4.
  it('activates an existing panel instead of adding a second one', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.openPanel('probe', 'Probe 1', { seat: 1 })

    await harness.controller.openPanel('probe', 'Probe 1 again', { seat: 1 })

    expect(harness.dockview.added.map((panel) => panel.id)).toEqual(['probe:{"seat":1}'])
    expect(harness.dockview.activated).toEqual(['probe:{"seat":1}'])
  })

  it('updates params when a caller supplies a stable panel id', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.openPanel('probe', 'First', { path: 'a.ts' }, 'file:key')

    await harness.controller.openPanel('probe', 'Second', { path: 'b.ts' }, 'file:key')

    expect(harness.dockview.added.map((panel) => panel.id)).toEqual(['file:key'])
    expect(harness.dockview.getPanel('file:key')?.params).toEqual({ path: 'b.ts' })
    expect(harness.dockview.getPanel('file:key')?.title).toBe('Second')
  })

  it('updates a stable panel when another window asks to activate it', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.openPanel('probe', 'First', { path: 'a.ts' }, 'file:key')

    expect(harness.controller.activatePanel('file:key', { path: 'b.ts' }, 'Second')).toBe(true)

    expect(harness.dockview.getPanel('file:key')?.params).toEqual({ path: 'b.ts' })
    expect(harness.dockview.getPanel('file:key')?.title).toBe('Second')
  })

  /**
   * The snapshot side of a rename: every window applies every snapshot, so what makes two windows
   * safe is that the controller writes only differences - the second application of the same
   * snapshot, whichever window it lands in, must touch nothing.
   */
  describe('renaming open panels from the sessions snapshot', () => {
    function seededForTitles(): TabsControllerHarness {
      const harness = TabsControllerHarness.fresh()
      harness.dockview.seedPanel(
        'terminal:{"sessionId":"s1"}', 'terminal', 'AppJamatV3 - 001', { sessionId: 's1' },
      )
      harness.dockview.seedPanel(
        'terminal:{"sessionId":"s2"}', 'terminal', 'AppJamatV3 - 002', { sessionId: 's2' },
      )
      harness.dockview.seedPanel('probe:{"sessionId":"s1"}', 'probe', 'Probe', { sessionId: 's1' })
      return harness
    }

    it('rewrites only the terminal panels whose title differs', () => {
      const harness = seededForTitles()

      harness.controller.applySessionTitles([
        { sessionId: 's1', tabTitle: 'AppJamatV3 - 001 - renamed' },
        { sessionId: 's2', tabTitle: 'AppJamatV3 - 002' },
      ])

      expect(harness.dockview.retitled).toEqual([
        { panelId: 'terminal:{"sessionId":"s1"}', title: 'AppJamatV3 - 001 - renamed' },
      ])
      expect(harness.dockview.getPanel('terminal:{"sessionId":"s1"}')?.title)
        .toBe('AppJamatV3 - 001 - renamed')
    })

    it('leaves non-terminal panels and sessions the snapshot does not name alone', () => {
      const harness = seededForTitles()

      // `s1` differs, but the probe panel carrying its id is not a terminal; `s-elsewhere` has no
      // panel here at all; and `s2`'s open panel is not named by this snapshot.
      harness.controller.applySessionTitles([
        { sessionId: 's-elsewhere', tabTitle: 'Nowhere' },
      ])

      expect(harness.dockview.retitled).toEqual([])
      expect(harness.dockview.getPanel('probe:{"sessionId":"s1"}')?.title).toBe('Probe')
      expect(harness.dockview.getPanel('terminal:{"sessionId":"s2"}')?.title)
        .toBe('AppJamatV3 - 002')
    })

    it('writes nothing the second time the same titles are applied', () => {
      const harness = seededForTitles()
      const titles = [{ sessionId: 's1', tabTitle: 'AppJamatV3 - 001 - renamed' }]

      harness.controller.applySessionTitles(titles)
      harness.controller.applySessionTitles(titles)

      expect(harness.dockview.retitled).toHaveLength(1)
    })

    it('retitles the same remote session id independently for each endpoint', () => {
      const harness = TabsControllerHarness.fresh()
      const first = { kind: 'remote' as const, remoteEndpointId: 'endpoint-a', sessionId: 'same' }
      const second = { kind: 'remote' as const, remoteEndpointId: 'endpoint-b', sessionId: 'same' }
      harness.dockview.seedPanel(
        'remote-a', 'terminal', 'Old A', TerminalTargetCodec.params(first),
      )
      harness.dockview.seedPanel(
        'remote-b', 'terminal', 'Old B', TerminalTargetCodec.params(second),
      )

      harness.controller.applyRemoteSessionTitles([
        {
          remoteEndpointId: 'endpoint-a',
          titles: [{ sessionId: 'same', tabTitle: 'New A' }],
        },
        {
          remoteEndpointId: 'endpoint-b',
          titles: [{ sessionId: 'same', tabTitle: 'New B' }],
        },
      ])

      expect(harness.dockview.retitled).toEqual([
        { panelId: 'remote-a', title: 'New A' },
        { panelId: 'remote-b', title: 'New B' },
      ])
    })
  })

  it('refuses a panel key the registry does not know', async () => {
    const harness = TabsControllerHarness.fresh()

    expect(await harness.controller.openPanel('missing', 'claude'))
      .toEqual({ kind: 'failed', detail: expect.stringMatching(/Unknown panel component/) })
    expect(harness.dockview.added).toEqual([])
  })

  it('claims before adding and maps a foreign owner or refusal without adding', async () => {
    const granted = TabsControllerHarness.fresh()
    const opened = await granted.controller.openPanel('terminal', 'One', { sessionId: 's1' })
    expect(opened).toEqual({ kind: 'opened', panelId: 'terminal:{"sessionId":"s1"}' })
    expect(granted.claimed).toEqual([{
      panelId: 'terminal:{"sessionId":"s1"}',
      key: 'terminal',
      title: 'One',
      params: { sessionId: 's1' },
      sessionId: 's1',
      presentation: 'session',
    }])

    const owned = TabsControllerHarness.fresh()
    owned.claimAnswer = { kind: 'owned', windowId: 'holder', panelId: 'elsewhere' }
    expect(await owned.controller.openPanel('probe', 'Probe', { serial: 1 })).toEqual({
      kind: 'focusedExisting',
      windowId: 'holder',
      panelId: 'elsewhere',
    })
    expect(owned.dockview.added).toEqual([])
    expect(owned.released).toEqual([])

    const refused = TabsControllerHarness.fresh()
    refused.claimAnswer = { kind: 'refused', detail: 'closing' }
    expect(await refused.controller.openPanel('probe', 'Probe', { serial: 1 }))
      .toEqual({ kind: 'failed', detail: 'closing' })
    expect(refused.dockview.added).toEqual([])
    expect(refused.released).toEqual([])
  })

  it('uses endpoint-scoped stable ids and presence for remote terminals', async () => {
    const harness = TabsControllerHarness.fresh()
    const first = { kind: 'remote' as const, remoteEndpointId: 'endpoint-a', sessionId: 'same' }
    const second = { kind: 'remote' as const, remoteEndpointId: 'endpoint-b', sessionId: 'same' }

    const openedFirst = await harness.controller.openPanel(
      'terminal', 'First', TerminalTargetCodec.params(first),
    )
    const openedSecond = await harness.controller.openPanel(
      'terminal', 'Second', TerminalTargetCodec.params(second),
    )
    expect(openedFirst).toMatchObject({ kind: 'opened' })
    expect(openedSecond).toMatchObject({ kind: 'opened' })
    if (openedFirst.kind !== 'opened' || openedSecond.kind !== 'opened')
      throw new Error('Remote panels were not opened')
    expect(openedFirst.panelId).not.toBe(openedSecond.panelId)
    expect(harness.claimed.map((panel) => ({
      params: panel.params,
      sessionId: panel.sessionId,
      presentation: panel.presentation,
    }))).toEqual([
      { params: TerminalTargetCodec.params(first), sessionId: null, presentation: null },
      { params: TerminalTargetCodec.params(second), sessionId: null, presentation: null },
    ])
  })

  it('releases only a granted claim when adding the panel fails', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.addFailure = new Error('dockview refused add')
    const panelId = TabsController.panelIdOf('probe', { serial: 1 })

    expect(await harness.controller.openPanel('probe', 'Probe', { serial: 1 }))
      .toEqual({ kind: 'failed', detail: 'dockview refused add' })
    expect(harness.released).toEqual([panelId])

    const refused = TabsControllerHarness.fresh()
    refused.claimAnswer = { kind: 'refused', detail: 'closing' }
    refused.dockview.addFailure = new Error('must not be reached')
    await refused.controller.openPanel('probe', 'Probe', { serial: 1 })
    expect(refused.released).toEqual([])
  })

  // Scenario 5: a new panel joins the active group; splitting is what splitActivePanel is for.
  it('adds a panel without a position of its own', async () => {
    const harness = TabsControllerHarness.fresh()
    await harness.controller.openPanel('probe', 'Probe 1', { seat: 1 })

    await harness.controller.openPanel('probe', 'Probe 2', { seat: 2 })

    expect(harness.dockview.added.map((panel) => panel.position)).toEqual([undefined, undefined])
    expect(harness.dockview.groups).toHaveLength(1)
  })

  // Scenario 6: the reason the guard exists - dockview would move the group beside itself.
  it('leaves the only panel of the only group where it is', () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['probe:{"seat":1}']], 'probe:{"seat":1}')

    harness.controller.splitActivePanel('right')

    expect(harness.dockview.moved).toEqual([])
  })

  /**
   * V1's four moves, ported for V1's keys. The direction is answered from where the groups actually
   * ARE, because the grid is a tree and "right" is not one of its axes: the group to the right may
   * be a sibling or a cousin three branches away, and a person means the one they can see.
   */
  it('moves the active panel into the group that lies that way', () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['probe:{"seat":1}'], ['probe:{"seat":2}']], 'probe:{"seat":1}')
    harness.dockview.place('group-0', { left: 0, top: 0, width: 100, height: 100 })
    harness.dockview.place('group-1', { left: 100, top: 0, width: 100, height: 100 })

    harness.controller.moveActivePanelInDirection('right')

    expect(harness.dockview.moved)
      .toEqual([{ panelId: 'probe:{"seat":1}', groupId: 'group-1', position: 'center' }])
  })

  it('splits its own group where nothing lies that way, and only when something stays behind', () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['probe:{"seat":1}'], ['probe:{"seat":2}']], 'probe:{"seat":1}')
    harness.dockview.place('group-0', { left: 0, top: 0, width: 100, height: 100 })
    harness.dockview.place('group-1', { left: 100, top: 0, width: 100, height: 100 })

    // Nothing to the left of the left-hand group, and its one panel would leave a group that then
    // vanishes - a rebuilt grid for the layout it already has.
    harness.controller.moveActivePanelInDirection('left')
    expect(harness.dockview.moved).toEqual([])

    const shared = TabsControllerHarness.fresh()
    shared.dockview.seed([['probe:{"seat":1}', 'probe:{"seat":2}']], 'probe:{"seat":2}')

    shared.controller.moveActivePanelInDirection('above')

    expect(shared.dockview.moved)
      .toEqual([{ panelId: 'probe:{"seat":2}', groupId: 'group-0', position: 'top' }])
  })

  it('moves the active panel out of a shared group into a new one', () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['probe:{"seat":1}', 'probe:{"seat":2}']], 'probe:{"seat":2}')

    harness.controller.splitActivePanel('right')

    expect(harness.dockview.moved)
      .toEqual([{ panelId: 'probe:{"seat":2}', groupId: 'group-0', position: 'right' }])
  })

  it('translates a downward split into dockview\'s bottom position', () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['probe:{"seat":1}'], ['probe:{"seat":2}']], 'probe:{"seat":2}')

    harness.controller.splitActivePanel('below')

    expect(harness.dockview.moved)
      .toEqual([{ panelId: 'probe:{"seat":2}', groupId: 'group-1', position: 'bottom' }])
  })

  // Scenario 7.
  it('activates the neighbour of the panel it closed, not the group\'s last tab', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a', 'b', 'c']], 'b')

    await harness.controller.hidePanel('b')

    expect(harness.dockview.removed).toEqual(['b'])
    expect(harness.dockview.activated).toEqual(['c'])
  })

  it('activates the previous tab when it closed the last one', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a', 'b', 'c']], 'c')

    await harness.controller.hidePanel('c')

    expect(harness.dockview.activated).toEqual(['b'])
  })

  it('restores the last parameters when a user closes and reopens a panel', async () => {
    const harness = TabsControllerHarness.fresh()
    const base = TerminalTargetCodec.params({ kind: 'local', sessionId: 's1' })
    const panelId = TabsController.panelIdOf(PanelKeysConst.terminal, base)
    const split = {
      ratio: 0.6,
      active: 'file-one',
      items: [{
        key: 'file-one',
        title: 'one.md',
        source: {
          kind: 'workspace',
          sessionId: 's1',
          path: 'Q:\\Apps\\Project\\one.md',
        },
      }],
    }
    await harness.controller.openPanel(PanelKeysConst.terminal, 'Session 1', base)
    harness.dockview.getPanel(panelId)?.api.updateParameters({
      sidebar: { visible: true, width: 440, activeView: 'workingTree' },
      split,
    })

    await harness.controller.hidePanel(panelId)
    expect(await harness.controller.openPanel(PanelKeysConst.terminal, 'Session 1', base))
      .toEqual({ kind: 'opened', panelId })

    expect(harness.dockview.getPanel(panelId)?.params).toEqual({
      ...base,
      sidebar: { visible: true, width: 440, activeView: 'workingTree' },
      split,
    })
  })

  it('does not restore parameters after an internal silent close', async () => {
    const harness = TabsControllerHarness.fresh()
    const base = { serial: 1 }
    const panelId = TabsController.panelIdOf(PanelKeysConst.probe, base)
    await harness.controller.openPanel(PanelKeysConst.probe, 'Probe', base)
    harness.dockview.getPanel(panelId)?.api.updateParameters({ sidebar: { visible: true } })

    await harness.controller.hidePanel(panelId, { silent: true })
    await harness.controller.openPanel(PanelKeysConst.probe, 'Probe', base)

    expect(harness.dockview.getPanel(panelId)?.params).toEqual(base)
  })

  it('clears remembered parameters with Reset Layout', async () => {
    const harness = TabsControllerHarness.fresh()
    const base = { serial: 1 }
    const panelId = TabsController.panelIdOf(PanelKeysConst.probe, base)
    await harness.controller.openPanel(PanelKeysConst.probe, 'Probe', base)
    harness.dockview.getPanel(panelId)?.api.updateParameters({ sidebar: { visible: true } })

    await harness.controller.resetLayout()
    await harness.controller.openPanel(PanelKeysConst.probe, 'Probe', base)

    expect(harness.dockview.getPanel(panelId)?.params).toEqual(base)
  })

  it('leaves the active tab alone when a background tab is closed', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a', 'b', 'c']], 'a')

    await harness.controller.hidePanel('c')

    expect(harness.dockview.removed).toEqual(['c'])
    expect(harness.dockview.activated).toEqual([])
  })

  it('releases ownership whenever dockview removes a panel', async () => {
    const harness = TabsControllerHarness.fresh()
    const panelId = TabsController.panelIdOf('probe', { serial: 1 })
    await harness.controller.openPanel('probe', 'Probe', { serial: 1 })

    await harness.controller.hidePanel(panelId, { silent: true })

    expect(harness.released).toEqual([panelId])
  })

  it('closes every other panel and keeps the one it was asked to keep', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a', 'b'], ['c']], 'a')

    await harness.controller.closeOtherPanels('b')

    expect(harness.dockview.removed).toEqual(['a', 'c'])
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual(['b'])
    expect(harness.dockview.activated).toContain('b')
  })

  it('empties the workspace and opens Home again on a reset', async () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a', 'b'], ['c']], 'a')

    await harness.controller.resetLayout()

    expect(harness.dockview.removed).toEqual(['a', 'b', 'c'])
    expect(harness.dockview.panels.map((panel) => panel.id)).toEqual(['welcome:{}'])
  })

  it('maximizes the active group and gives the same command back to exit', () => {
    const harness = TabsControllerHarness.fresh()
    harness.dockview.seed([['a'], ['b']], 'b')

    harness.controller.toggleMaximizeActiveGroup()
    harness.controller.toggleMaximizeActiveGroup()

    expect(harness.dockview.maximized).toEqual(['b', 'exit'])
  })

  /**
   * The one close that can end what is behind it. It hangs on the four paths a person can reach and
   * on nothing else: the window tearing down empties dockview without passing through any of them,
   * which is what keeps "closing a client detaches" true.
   */
  describe('the question asked before a user closes a panel', () => {
    it('asks about the panel being closed, with its key and its parameters', async () => {
      const harness = TabsControllerHarness.fresh()
      await harness.controller.openPanel('probe', 'Probe', {
        sessionId: 's1',
        presentation: 'tab',
      })

      await harness.controller.hidePanel(TabsController.panelIdOf(
        'probe',
        { sessionId: 's1', presentation: 'tab' },
      ))

      expect(harness.asked).toEqual([
        { key: 'probe', params: { sessionId: 's1', presentation: 'tab' } },
      ])
      expect(harness.dockview.removed).toEqual(['probe:{"sessionId":"s1","presentation":"tab"}'])
    })

    it('leaves the panel where it is when the answer is no', async () => {
      const harness = TabsControllerHarness.fresh()
      await harness.controller.openPanel('probe', 'Probe', { serial: 1 })
      harness.allowsClose = false

      await harness.controller.hidePanel(TabsController.panelIdOf('probe', { serial: 1 }))

      expect(harness.dockview.removed).toEqual([])
    })

    // Re-keying a promoted tab is this client closing a panel to itself, and ending the session is
    // exactly what must not happen there.
    it('asks nothing at all for a silent close', async () => {
      const harness = TabsControllerHarness.fresh()
      await harness.controller.openPanel('probe', 'Probe', { serial: 1 })
      harness.allowsClose = false

      await harness.controller.hidePanel(
        TabsController.panelIdOf('probe', { serial: 1 }),
        { silent: true },
      )

      expect(harness.asked).toEqual([])
      expect(harness.dockview.removed).toEqual(['probe:{"serial":1}'])
    })

    it('asks once per panel when closing the others, and keeps the ones that refused', async () => {
      const harness = TabsControllerHarness.fresh()
      await harness.controller.openPanel('probe', 'A', { serial: 1 })
      await harness.controller.openPanel('probe', 'B', { serial: 2 })
      await harness.controller.openPanel('probe', 'C', { serial: 3 })
      harness.allowsClose = false

      await harness.controller.closeOtherPanels(TabsController.panelIdOf('probe', { serial: 2 }))

      expect(harness.asked).toHaveLength(2)
      expect(harness.dockview.removed).toEqual([])
    })

    // The teardown path: dockview empties itself, and the controller is only told to stop listening.
    it('is not asked when the window is torn down', async () => {
      const harness = TabsControllerHarness.fresh()
      await harness.controller.openPanel('probe', 'A', { serial: 1 })

      harness.controller.dispose()

      expect(harness.asked).toEqual([])
    })
  })

  describe('the preview tab', () => {
    const sessionParams = (sessionId: string): Record<string, unknown> => ({ sessionId })
    const sessionPanelId = (sessionId: string): string =>
      TabsController.panelIdOf('terminal', sessionParams(sessionId))

    async function openPreview(
      harness: TabsControllerHarness,
      sessionId: string,
    ): Promise<PanelOpenOutcome> {
      return harness.controller.openPanel(
        'terminal',
        sessionId,
        sessionParams(sessionId),
        undefined,
        { preview: true },
      )
    }

    it('marks the panel it opened and tells whoever is listening', async () => {
      const harness = TabsControllerHarness.fresh()
      let notifications = 0
      harness.controller.subscribePreview(() => { notifications += 1 })

      await openPreview(harness, 's1')

      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)
      expect(notifications).toBe(1)
    })

    it('adds the replacement before it removes what it replaces', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')
      let replacementWasThere: boolean | null = null
      harness.dockview.onDidRemovePanel(() => {
        replacementWasThere = harness.dockview.getPanel(sessionPanelId('s2')) !== undefined
      })

      await openPreview(harness, 's2')

      expect(replacementWasThere).toBe(true)
      expect(harness.dockview.removed).toEqual([sessionPanelId('s1')])
      // Silent: the session behind a preview keeps running, so nothing is asked and nothing is ended.
      expect(harness.asked).toEqual([])
      expect(harness.controller.isPreview(sessionPanelId('s2'))).toBe(true)
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(false)
    })

    it('puts the replacement in the outgoing tab place when that group is the active one', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')
      const outgoing = harness.dockview.getPanel(sessionPanelId('s1'))

      await openPreview(harness, 's2')

      expect(harness.dockview.added[1]?.position)
        .toEqual({ referenceGroup: outgoing?.group, direction: 'within', index: 0 })
    })

    it('places the replacement normally when the outgoing tab is in another group', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')
      harness.dockview.seed([['elsewhere']], 'elsewhere')

      await openPreview(harness, 's2')

      expect(harness.dockview.added[1]?.position).toBeUndefined()
    })

    it('keeps the previous preview when another window already owns the panel', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')
      harness.claimAnswer = { kind: 'owned', windowId: 'holder', panelId: 'elsewhere' }

      const outcome = await openPreview(harness, 's2')

      expect(outcome).toEqual({ kind: 'focusedExisting', windowId: 'holder', panelId: 'elsewhere' })
      expect(harness.dockview.removed).toEqual([])
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)
    })

    it('keeps the previous preview when the claim is refused', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')
      harness.claimAnswer = { kind: 'refused', detail: 'closing' }

      const outcome = await openPreview(harness, 's2')

      expect(outcome).toEqual({ kind: 'failed', detail: 'closing' })
      expect(harness.dockview.removed).toEqual([])
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)
    })

    it('stays a preview when the same row is clicked again', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')

      await openPreview(harness, 's1')

      expect(harness.dockview.added).toHaveLength(1)
      expect(harness.dockview.removed).toEqual([])
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)
    })

    it('promotes the panel when the same thing is opened deliberately', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')
      let notifications = 0
      harness.controller.subscribePreview(() => { notifications += 1 })

      await harness.controller.openPanel('terminal', 's1', sessionParams('s1'))

      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(false)
      expect(notifications).toBe(1)
      expect(harness.dockview.removed).toEqual([])
    })

    it('leaves the preview alone when a permanent panel is opened beside it', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')

      await harness.controller.openPanel('terminal', 's2', sessionParams('s2'))

      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)
      expect(harness.dockview.removed).toEqual([])
    })

    it('promotes a tab that was moved, and only that tab', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')
      await harness.controller.openPanel('terminal', 's2', sessionParams('s2'))

      harness.dockview.emitMovePanel(sessionPanelId('s2'))
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)

      harness.dockview.emitMovePanel(sessionPanelId('s1'))
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(false)
    })

    it('forgets the preview when dockview removes that panel', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')

      await harness.controller.hidePanel(sessionPanelId('s1'), { silent: true })

      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(false)
    })

    it('refuses to make a plain tab a preview, before it asks for the panel', async () => {
      const harness = TabsControllerHarness.fresh()

      const outcome = await harness.controller.openPanel(
        'terminal',
        'Plain',
        { sessionId: 's1', presentation: 'tab' },
        undefined,
        { preview: true },
      )

      expect(outcome.kind).toBe('failed')
      expect(harness.claimed).toEqual([])
      expect(harness.dockview.added).toEqual([])
    })

    it('keeps open only the panel it was given', async () => {
      const harness = TabsControllerHarness.fresh()
      await openPreview(harness, 's1')

      harness.controller.keepOpen(sessionPanelId('s2'))
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)

      harness.controller.keepOpen(sessionPanelId('s1'))
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(false)
    })

    /*
     * A double-click sends both single clicks first, so three opens of one session are in flight at
     * once and all three pass the "is it here already" check before any of them has added anything.
     */
    it('adds one panel when the same row is clicked twice before the claim answers', async () => {
      const harness = TabsControllerHarness.fresh()

      const outcomes = await Promise.all([openPreview(harness, 's1'), openPreview(harness, 's1')])

      expect(outcomes.map((outcome) => outcome.kind)).toEqual(['opened', 'opened'])
      expect(harness.dockview.added).toHaveLength(1)
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(true)
      // The panel that won the race holds the claim; the loser must not hand it back underneath it.
      expect(harness.released).toEqual([])
    })

    it('promotes when a deliberate open races the preview that opened the panel', async () => {
      const harness = TabsControllerHarness.fresh()

      await Promise.all([
        openPreview(harness, 's1'),
        harness.controller.openPanel('terminal', 's1', sessionParams('s1')),
      ])

      expect(harness.dockview.added).toHaveLength(1)
      expect(harness.controller.isPreview(sessionPanelId('s1'))).toBe(false)
      expect(harness.released).toEqual([])
    })

    it('stops listening for moves when it is disposed', () => {
      const harness = TabsControllerHarness.fresh()
      expect(harness.dockview.movePanelListenerCount).toBe(1)

      harness.controller.dispose()

      expect(harness.dockview.movePanelListenerCount).toBe(0)
    })

    it('does not subscribe twice when it is attached again', () => {
      const harness = TabsControllerHarness.fresh()

      harness.controller.attach(harness.dockview.asApi())

      expect(harness.dockview.movePanelListenerCount).toBe(1)
    })
  })
})
