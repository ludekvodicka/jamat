import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SessionAgentId } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  LoadLayoutResult,
  LoadSessionsViewResult,
  LoadSidebarsResult,
} from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import { type SessionsTabsView, SessionsViewState } from '../../shared/sessionsViewState'
import { type SavedSessionsFilter, SessionsFilterState } from '../../shared/sessionsFilterState'
import { type SidebarsStateValue, SidebarsState } from '../../shared/sidebarsState'
import type { WindowAppearance } from '../../shared/windowInfo'
import { WindowAppearanceRules } from '../shell/windowAppearance'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export type WindowBoundsKey = 'main' | 'debug' | { extraWindowId: string }

interface WindowAppearanceState {
  name?: string
  color?: string
}

export interface ExtraWindowState extends WindowAppearanceState {
  bounds?: WindowBounds
  layout?: string
  closed?: true
}

interface ClientStateFields {
  layout?: string
  windowBounds?: WindowBounds
  debugWindowBounds?: WindowBounds
  sidebars?: SidebarsStateValue
  sessionsView?: SessionsTabsView
  sessionFilters?: readonly SavedSessionsFilter[]
  newSessionAgent?: SessionAgentId
}

interface ClientStateDocumentV1 extends ClientStateFields {
  schemaVersion: 1
}

interface ClientStateDocumentV2 extends ClientStateFields {
  schemaVersion: 2
  mainWindow?: WindowAppearanceState
  extraWindows?: Record<string, ExtraWindowState>
}

/**
 * The layouts, appearance and bounds of every client window, plus the main window's sidebar state,
 * in one file with one writer. Schema 1 is upgraded only in memory until the next mutation.
 */
export class ClientStateStore {
  private static readonly schemaVersionConst = 2
  private static readonly snapshotKeepConst = 10
  private static readonly snapshotPatternConst =
    /^client-state-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/
  private document: ClientStateDocumentV2 | null = null
  private readFailed = false
  private refusalReported = false

  constructor(
    private readonly stateFile: string,
    private readonly snapshotsDirectory: string,
    private readonly report: (message: string) => void,
  ) {}

  loadLayout(windowId: string): LoadLayoutResult {
    const document = this.documentOnDisk()
    const layout = windowId === 'main'
      ? document.layout
      : document.extraWindows?.[windowId]?.layout
    return { layout: layout ?? null, failed: this.readFailed }
  }

  saveLayout(windowId: string, layout: string): boolean {
    // Validation precedes the read latch. Bad caller input still throws, while a valid write that
    // the damaged document refuses returns false and leaves its only recoverable copy untouched.
    ClientStateStore.validateLayout(layout)
    const document = this.documentOnDisk()
    if (windowId === 'main')
      return this.write({ ...document, layout }, { snapshotLayout: true })
    return this.updateExtraWindow(
      windowId,
      (window) => ({ ...window, layout }),
      { snapshotLayout: true },
    )
  }

  clearLayout(windowId: string): boolean {
    const document = this.documentOnDisk()
    if (windowId === 'main') {
      const next = { ...document }
      delete next.layout
      return this.write(next, { snapshotLayout: true })
    }
    return this.updateExtraWindow(
      windowId,
      (window) => {
        const next = { ...window }
        delete next.layout
        return next
      },
      { snapshotLayout: true },
    )
  }

  loadSidebars(): LoadSidebarsResult {
    return { sidebars: this.documentOnDisk().sidebars ?? null, failed: this.readFailed }
  }

  /** False is a refusal, the same as every other mutator here: the drag was not stored. */
  saveSidebars(sidebars: SidebarsStateValue): boolean {
    // Sidebar drags share the document barrier but spend no layout recovery points.
    if (!SidebarsState.isValid(sidebars))
      throw new Error(`Refusing to store sidebar state: ${JSON.stringify(sidebars)}`)
    const document = this.documentOnDisk()
    return this.write({ ...document, sidebars }, { snapshotLayout: false })
  }

  loadSessionsView(): LoadSessionsViewResult {
    return { sessionsView: this.documentOnDisk().sessionsView ?? null }
  }

  saveSessionsView(view: SessionsTabsView): boolean {
    // Refused on write and coerced on read, like the sidebar state beside it.
    if (!SessionsViewState.isValid(view))
      throw new Error(`Refusing to store the sessions view: ${JSON.stringify(view)}`)
    const document = this.documentOnDisk()
    return this.write({ ...document, sessionsView: view }, { snapshotLayout: false })
  }

  loadNewSessionAgent(): SessionAgentId {
    return this.documentOnDisk().newSessionAgent ?? 'claude'
  }

  loadSessionFilters(): readonly SavedSessionsFilter[] {
    return structuredClone(this.documentOnDisk().sessionFilters ?? [])
  }

  saveSessionFilters(filters: readonly SavedSessionsFilter[]): boolean {
    if (!SessionsFilterState.isSavedList(filters))
      throw new Error('Refusing to store invalid session filters')
    return this.write(
      { ...this.documentOnDisk(), sessionFilters: structuredClone(filters) },
      { snapshotLayout: false },
    )
  }

  saveNewSessionAgent(agentId: SessionAgentId): boolean {
    if (agentId !== 'claude' && agentId !== 'codex')
      throw new Error(`Refusing to store a new-session agent: ${JSON.stringify(agentId)}`)
    const document = this.documentOnDisk()
    return this.write({ ...document, newSessionAgent: agentId }, { snapshotLayout: false })
  }

  loadWindowBounds(key: WindowBoundsKey): WindowBounds | null {
    const document = this.documentOnDisk()
    if (key === 'main')
      return document.windowBounds ?? null
    else if (key === 'debug')
      return document.debugWindowBounds ?? null
    else if (key !== null && typeof key === 'object' && typeof key.extraWindowId === 'string')
      return document.extraWindows?.[key.extraWindowId]?.bounds ?? null
    else
      throw new Error(`Unknown window bounds key: ${JSON.stringify(key)}`)
  }

  saveWindowBounds(key: WindowBoundsKey, bounds: WindowBounds): boolean {
    const normalized = ClientStateStore.normalizeBounds(bounds)
    if (!normalized)
      throw new Error(`Refusing to store window bounds: ${JSON.stringify(bounds)}`)
    const document = this.documentOnDisk()
    if (key === 'main')
      return this.write({ ...document, windowBounds: normalized }, { snapshotLayout: false })
    else if (key === 'debug')
      return this.write({ ...document, debugWindowBounds: normalized }, { snapshotLayout: false })
    else if (key !== null && typeof key === 'object' && typeof key.extraWindowId === 'string')
      return this.updateExtraWindow(
        key.extraWindowId,
        (window) => ({ ...window, bounds: normalized }),
        { snapshotLayout: false },
      )
    else
      throw new Error(`Unknown window bounds key: ${JSON.stringify(key)}`)
  }

  loadWindowAppearance(windowId: string): WindowAppearance {
    const document = this.documentOnDisk()
    const appearance = windowId === 'main'
      ? document.mainWindow
      : document.extraWindows?.[windowId]
    return { name: appearance?.name ?? null, color: appearance?.color ?? null }
  }

  saveWindowAppearance(windowId: string, appearance: WindowAppearance): boolean {
    ClientStateStore.validateAppearance(appearance)
    const state = ClientStateStore.appearanceStateOf(appearance)
    const document = this.documentOnDisk()
    if (windowId === 'main') {
      const next = { ...document }
      if (Object.keys(state).length === 0)
        delete next.mainWindow
      else
        next.mainWindow = state
      return this.write(next, { snapshotLayout: false })
    }
    return this.updateExtraWindow(
      windowId,
      (window) => {
        const next = { ...window, ...state }
        if (appearance.name === null)
          delete next.name
        if (appearance.color === null)
          delete next.color
        return next
      },
      { snapshotLayout: false },
    )
  }

  isNamed(windowId: string): boolean {
    return this.loadWindowAppearance(windowId).name !== null
  }

  listExtraWindows(): Readonly<Record<string, ExtraWindowState>> {
    const windows = this.documentOnDisk().extraWindows ?? {}
    return Object.fromEntries(Object.entries(windows).map(([windowId, state]) => [
      windowId,
      { ...state, ...(state.bounds === undefined ? {} : { bounds: { ...state.bounds } }) },
    ]))
  }

  markExtraWindowOpen(windowId: string): boolean {
    const document = this.documentOnDisk()
    const window = { ...document.extraWindows?.[windowId] }
    delete window.closed
    return this.write(
      { ...document, extraWindows: { ...document.extraWindows, [windowId]: window } },
      { snapshotLayout: false },
    )
  }

  markExtraWindowClosed(windowId: string): boolean {
    const document = this.documentOnDisk()
    if (this.readFailed)
      return this.refuseReadFailure()
    const window = document.extraWindows?.[windowId]
    if (window === undefined)
      return this.refuseMissingExtraWindow(windowId)
    const extraWindows = { ...document.extraWindows }
    if (window.name === undefined)
      delete extraWindows[windowId]
    else
      extraWindows[windowId] = { ...window, closed: true }
    const next = { ...document }
    if (Object.keys(extraWindows).length === 0)
      delete next.extraWindows
    else
      next.extraWindows = extraWindows
    return this.write(
      next,
      { snapshotLayout: window.name === undefined && window.layout !== undefined },
    )
  }

  private updateExtraWindow(
    windowId: string,
    update: (window: ExtraWindowState) => ExtraWindowState,
    options: { snapshotLayout: boolean },
  ): boolean {
    const document = this.documentOnDisk()
    if (this.readFailed)
      return this.refuseReadFailure()
    const window = document.extraWindows?.[windowId]
    if (window === undefined)
      return this.refuseMissingExtraWindow(windowId)
    return this.write(
      {
        ...document,
        extraWindows: { ...document.extraWindows, [windowId]: update(window) },
      },
      options,
    )
  }

  private refuseMissingExtraWindow(windowId: string): false {
    this.report(`Client state has no extra window ${JSON.stringify(windowId)}; nothing was written`)
    return false
  }

  private refuseReadFailure(): false {
    this.reportRefusal()
    return false
  }

  private documentOnDisk(): ClientStateDocumentV2 {
    if (!this.document)
      this.document = this.readDocument()
    return this.document
  }

  private readDocument(): ClientStateDocumentV2 {
    if (!existsSync(this.stateFile))
      return { schemaVersion: ClientStateStore.schemaVersionConst }
    try {
      return ClientStateStore.coerceDocument(
        JSON.parse(readFileSync(this.stateFile, 'utf8')),
        (message) => this.report(message),
      )
    } catch (error) {
      // The damaged file is never deleted. It and the snapshots are the only recoverable copies.
      this.readFailed = true
      this.report(
        `Client state at ${this.stateFile} is unreadable (${ErrorText.of(error)}); starting from an empty state`,
      )
      return { schemaVersion: ClientStateStore.schemaVersionConst }
    }
  }

  private static coerceDocument(raw: unknown, report: (message: string) => void): ClientStateDocumentV2 {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Client state must be an object')
    const document = raw as { schemaVersion?: unknown }
    if (document.schemaVersion === 1)
      return ClientStateStore.migrateV1(ClientStateStore.coerceV1(raw, report))
    else if (document.schemaVersion === 2)
      return ClientStateStore.coerceV2(raw, report)
    else
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
  }

  private static coerceV1(raw: unknown, report: (message: string) => void): ClientStateDocumentV1 {
    return { schemaVersion: 1, ...ClientStateStore.coerceFields(raw, report) }
  }

  private static migrateV1(document: ClientStateDocumentV1): ClientStateDocumentV2 {
    return { ...document, schemaVersion: ClientStateStore.schemaVersionConst }
  }

  private static coerceV2(raw: unknown, report: (message: string) => void): ClientStateDocumentV2 {
    const document = raw as {
      mainWindow?: unknown
      extraWindows?: unknown
    }
    const mainWindow = ClientStateStore.coerceAppearance(document.mainWindow, 'main window', report)
    const extraWindows = ClientStateStore.coerceExtraWindows(document.extraWindows, report)
    return {
      schemaVersion: ClientStateStore.schemaVersionConst,
      ...ClientStateStore.coerceFields(raw, report),
      ...(mainWindow === undefined ? {} : { mainWindow }),
      ...(extraWindows === undefined ? {} : { extraWindows }),
    }
  }

  private static coerceFields(raw: unknown, report: (message: string) => void): ClientStateFields {
    const document = raw as {
      layout?: unknown
      windowBounds?: unknown
      debugWindowBounds?: unknown
      sidebars?: unknown
      sessionsView?: unknown
      sessionFilters?: unknown
      newSessionAgent?: unknown
    }
    if (document.layout !== undefined && typeof document.layout !== 'string')
      throw new Error('layout must be a string')
    const bounds = ClientStateStore.coerceBounds(document.windowBounds, 'main window bounds', report)
    const debugBounds = ClientStateStore.coerceBounds(
      document.debugWindowBounds,
      'Debug window bounds',
      report,
    )
    const newSessionAgent = ClientStateStore
      .coerceNewSessionAgent(document.newSessionAgent, report)
    return {
      ...(document.layout === undefined ? {} : { layout: document.layout }),
      ...(document.sessionFilters === undefined ? {} : {
        sessionFilters: SessionsFilterState.coerceSaved(document.sessionFilters, report),
      }),
      ...(bounds === undefined ? {} : { windowBounds: bounds }),
      ...(debugBounds === undefined ? {} : { debugWindowBounds: debugBounds }),
      ...(document.sidebars === undefined
        ? {}
        : { sidebars: SidebarsState.coerce(document.sidebars) }),
      ...(document.sessionsView === undefined
        ? {}
        : { sessionsView: SessionsViewState.coerce(document.sessionsView, report) }),
      ...(newSessionAgent === undefined ? {} : { newSessionAgent }),
    }
  }

  private static coerceNewSessionAgent(
    value: unknown,
    report: (message: string) => void,
  ): SessionAgentId | undefined {
    if (value === undefined) return undefined
    if (value === 'claude') return value
    else if (value === 'codex') return value
    report(`Client state new-session agent is invalid (${JSON.stringify(value)}); reading Claude`)
    return undefined
  }

  private static coerceExtraWindows(
    raw: unknown,
    report: (message: string) => void,
  ): Record<string, ExtraWindowState> | undefined {
    if (raw === undefined)
      return undefined
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('extraWindows must be an object')
    return Object.fromEntries(Object.entries(raw).map(([windowId, window]) => [
      windowId,
      ClientStateStore.coerceExtraWindow(window, windowId, report),
    ]))
  }

  private static coerceExtraWindow(
    raw: unknown,
    windowId: string,
    report: (message: string) => void,
  ): ExtraWindowState {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`invalid extra window entry: ${windowId}`)
    const window = raw as {
      bounds?: unknown
      layout?: unknown
      name?: unknown
      color?: unknown
      closed?: unknown
    }
    if (window.layout !== undefined && typeof window.layout !== 'string')
      throw new Error(`invalid extra window layout: ${windowId}`)
    const bounds = ClientStateStore.coerceBounds(
      window.bounds,
      `bounds for extra window ${JSON.stringify(windowId)}`,
      report,
    )
    const appearance = ClientStateStore.coerceAppearance(
      window,
      `extra window ${JSON.stringify(windowId)}`,
      report,
    ) ?? {}
    if (window.closed !== undefined && window.closed !== true)
      report(
        `Client state closed flag for extra window ${JSON.stringify(windowId)} is invalid; ignoring it`,
      )
    return {
      ...(window.layout === undefined ? {} : { layout: window.layout }),
      ...(bounds === undefined ? {} : { bounds }),
      ...appearance,
      ...(window.closed === true ? { closed: true as const } : {}),
    }
  }

  private static coerceAppearance(
    raw: unknown,
    subject: string,
    report: (message: string) => void,
  ): WindowAppearanceState | undefined {
    if (raw === undefined)
      return undefined
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      report(`Client state ${subject} appearance is invalid; ignoring it`)
      return undefined
    }
    const appearance = raw as { name?: unknown; color?: unknown }
    const result: WindowAppearanceState = {}
    if (typeof appearance.name === 'string')
      result.name = appearance.name
    else if (appearance.name !== undefined)
      report(`Client state ${subject} name is invalid; ignoring it`)
    if (typeof appearance.color === 'string' && WindowAppearanceRules.isColor(appearance.color))
      result.color = appearance.color
    else if (appearance.color !== undefined)
      // Dropped rather than carried: `WindowIcon.of` throws on a colour off this pattern, and it
      // runs while the first window is being built, where nothing catches. A file with `"red"`
      // in it used to end the boot with no window on screen and no way to say so.
      report(`Client state ${subject} color is invalid; ignoring it`)
    return result
  }

  private static coerceBounds(
    raw: unknown,
    subject: string,
    report: (message: string) => void,
  ): WindowBounds | undefined {
    if (raw === undefined)
      return undefined
    const bounds = ClientStateStore.normalizeBounds(raw)
    if (bounds !== null)
      return bounds
    report(`Client state ${subject} are invalid; ignoring them`)
    return undefined
  }

  private static validateLayout(layout: string): void {
    let parsed: unknown
    try { parsed = JSON.parse(layout) }
    catch (error) {
      throw new Error(`Refusing to store a layout that is not JSON: ${ErrorText.of(error)}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(`Refusing to store a layout that is not an object: ${layout.slice(0, 40)}`)
  }

  private static validateAppearance(appearance: WindowAppearance): void {
    if (appearance.name !== null && typeof appearance.name !== 'string')
      throw new Error(`Refusing to store window appearance: ${JSON.stringify(appearance)}`)
    if (appearance.color !== null && typeof appearance.color !== 'string')
      throw new Error(`Refusing to store window appearance: ${JSON.stringify(appearance)}`)
  }

  private static appearanceStateOf(appearance: WindowAppearance): WindowAppearanceState {
    return {
      ...(appearance.name === null ? {} : { name: appearance.name }),
      ...(appearance.color === null ? {} : { color: appearance.color }),
    }
  }

  private static normalizeBounds(value: unknown): WindowBounds | null {
    // A stored rectangle is untrusted input; the display clamp belongs to the window object.
    if (!value || typeof value !== 'object') return null
    const bounds = value as Partial<WindowBounds>
    if (typeof bounds.maximized !== 'boolean') return null
    if (!ClientStateStore.isCoordinate(bounds.x) || !ClientStateStore.isCoordinate(bounds.y))
      return null
    if (!ClientStateStore.isExtent(bounds.width) || !ClientStateStore.isExtent(bounds.height))
      return null
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: bounds.maximized,
    }
  }

  private static isCoordinate(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value)
  }

  private static isExtent(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  }

  private write(next: ClientStateDocumentV2, options: { snapshotLayout: boolean }): boolean {
    // Reading first makes the file, not caller order, decide the document-wide write barrier.
    this.documentOnDisk()
    if (this.readFailed)
      return this.refuseReadFailure()
    AtomicJsonFile.ensureDirectory(dirname(this.stateFile))
    if (options.snapshotLayout)
      this.snapshotCurrent()
    AtomicJsonFile.write(this.stateFile, next)
    this.document = next
    return true
  }

  private reportRefusal(): void {
    // A bounds timer may call repeatedly while the file is latched. One report carries the reason.
    if (this.refusalReported)
      return
    this.refusalReported = true
    this.report(
      `Client state at ${this.stateFile} was unreadable; nothing is written for the rest of this session`,
    )
  }

  private snapshotCurrent(): void {
    if (!existsSync(this.stateFile)) return
    try {
      AtomicJsonFile.ensureDirectory(this.snapshotsDirectory)
      // The random tie-break prevents two runs in the same millisecond from replacing one snapshot.
      copyFileSync(
        this.stateFile,
        join(this.snapshotsDirectory, `client-state-${Date.now()}-${randomUUID()}.json`),
      )
      this.rotateSnapshots()
    } catch (error) {
      // A failed recovery copy must not prevent the new atomic state write.
      this.report(`Client state snapshot failed: ${ErrorText.of(error)}`)
    }
  }

  private rotateSnapshots(): void {
    const names = readdirSync(this.snapshotsDirectory)
      .filter((name) => ClientStateStore.snapshotPatternConst.test(name))
      .sort()
    for (const name of names.slice(0, Math.max(0, names.length - ClientStateStore.snapshotKeepConst)))
      unlinkSync(join(this.snapshotsDirectory, name))
  }
}
