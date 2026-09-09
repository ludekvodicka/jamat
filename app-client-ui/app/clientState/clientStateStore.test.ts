import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SidebarsState, type SidebarsStateValue } from '../../shared/sidebarsState'
import { SessionsFilterState, type SavedSessionsFilter } from '../../shared/sessionsFilterState'
import {
  ClientStateStore,
  type ExtraWindowState,
  type WindowBounds,
} from './clientStateStore'

describe('app-client-ui/app/clientState/clientStateStore', () => {
  const created: string[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Fixture {
    store: ClientStateStore
    stateFile: string
    snapshotsDirectory: string
    reports: string[]
    /** A second store over the same files, standing in for a second run of the app. */
    reopen(): ClientStateStore
  }

  function fixture(): Fixture {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-state-'))
    created.push(directory)
    const stateFile = join(directory, 'client-state.json')
    const snapshotsDirectory = join(directory, 'snapshots')
    const reports: string[] = []
    const build = (): ClientStateStore =>
      new ClientStateStore(stateFile, snapshotsDirectory, (message) => reports.push(message))
    return {
      store: build(),
      stateFile,
      snapshotsDirectory,
      reports,
      reopen: build,
    }
  }

  function snapshotNames(snapshotsDirectory: string): string[] {
    return existsSync(snapshotsDirectory) ? readdirSync(snapshotsDirectory) : []
  }

  interface StoredDocument {
    schemaVersion?: number
    layout?: string
    windowBounds?: WindowBounds
    debugWindowBounds?: WindowBounds
    sidebars?: SidebarsStateValue
    sessionsView?: string
    newSessionAgent?: string
    mainWindow?: { name?: string; color?: string }
    extraWindows?: Record<string, ExtraWindowState>
  }

  function documentIn(file: string): StoredDocument {
    return JSON.parse(readFileSync(file, 'utf8')) as StoredDocument
  }

  const boundsFixtureConst: WindowBounds =
    { x: 120, y: 80, width: 1280, height: 800, maximized: false }

  it('preserves saved filters across restarts and unrelated state writes, without accepting malformed filters', () => {
    const { store, reopen, snapshotsDirectory } = fixture()
    const filters: SavedSessionsFilter[] = [{ id: 'questions', name: 'Questions', filterText: 'AppJamatV3',
      filters: { ...SessionsFilterState.defaultConst, colors: ['red', null], states: ['question'], agents: ['codex'] } }]
    expect(store.loadSessionFilters()).toEqual([])
    expect(store.saveSessionFilters(filters)).toBe(true)
    store.saveSessionsView('together')
    expect(reopen().loadSessionFilters()).toEqual(filters)
    expect(snapshotNames(snapshotsDirectory)).toEqual([])
    store.saveSessionsView('states')
    expect(reopen().loadSessionsView()).toEqual({ sessionsView: 'states' })
    expect(reopen().loadSessionFilters()).toEqual(filters)
    expect(() => store.saveSessionFilters([{ ...filters[0]!, filters: { ...filters[0]!.filters, states: ['invalid' as never] } }]))
      .toThrow('invalid session filters')
    expect(reopen().loadSessionFilters()).toEqual(filters)
    const changed = store.loadSessionFilters()
    changed[0]!.name = 'Changed outside the store'
    expect(store.loadSessionFilters()).toEqual(filters)
    expect(store.saveSessionFilters([])).toBe(true)
    expect(reopen().loadSessionFilters()).toEqual([])
  })

  it('reports no layout and no failure before anything was stored', () => {
    const { store } = fixture()
    expect(store.loadLayout('main')).toEqual({ layout: null, failed: false })
  })

  it('opens both production schema 1 shapes without reporting and upgrades on the first mutation', () => {
    const documents = [
      {
        schemaVersion: 1,
        layout: '{"panels":{"terminal":{}}}',
        windowBounds: boundsFixtureConst,
        debugWindowBounds: { ...boundsFixtureConst, x: 40 },
        sidebars: SidebarsState.default(),
        sessionsView: 'separated',
      },
      {
        schemaVersion: 1,
        layout: '{"panels":{"welcome":{},"probe":{}}}',
        windowBounds: { ...boundsFixtureConst, x: 781 },
        sidebars: SidebarsState.withWidth(SidebarsState.default(), 'left', 324),
      },
    ] as const

    for (const source of documents) {
      const { store, stateFile, reports } = fixture()
      writeFileSync(stateFile, JSON.stringify(source), 'utf8')

      expect(store.loadLayout('main')).toEqual({ layout: source.layout, failed: false })
      expect(store.loadWindowBounds('main')).toEqual(source.windowBounds)
      expect(store.loadSidebars().sidebars).toEqual(source.sidebars)
      expect(reports).toEqual([])
      expect(documentIn(stateFile).schemaVersion).toBe(1)

      expect(store.saveWindowBounds('main', { ...source.windowBounds, x: 900 })).toBe(true)

      const written = documentIn(stateFile)
      expect(written.schemaVersion).toBe(2)
      expect(written.layout).toBe(source.layout)
      expect(written.sidebars).toEqual(source.sidebars)
      if ('debugWindowBounds' in source)
        expect(written.debugWindowBounds).toEqual(source.debugWindowBounds)
      if ('sessionsView' in source)
        expect(written.sessionsView).toBe(source.sessionsView)
    }
  })

  it('round-trips schema 2 with main and extra window state', () => {
    const { store, stateFile, reopen, reports } = fixture()
    const holderBounds = { ...boundsFixtureConst, x: 500 }
    writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 2,
      layout: '{"main":1}',
      mainWindow: { name: 'Primary', color: '#123456' },
      extraWindows: {
        holder: {
          layout: '{"holder":1}',
          bounds: holderBounds,
          name: 'Logs',
          color: '#abcdef',
          closed: true,
        },
      },
    }), 'utf8')

    expect(store.loadLayout('main').layout).toBe('{"main":1}')
    expect(store.loadLayout('holder').layout).toBe('{"holder":1}')
    expect(store.loadWindowBounds({ extraWindowId: 'holder' })).toEqual(holderBounds)
    expect(store.loadWindowAppearance('main')).toEqual({ name: 'Primary', color: '#123456' })
    expect(store.loadWindowAppearance('holder')).toEqual({ name: 'Logs', color: '#abcdef' })
    expect(store.listExtraWindows().holder.closed).toBe(true)
    expect(reports).toEqual([])

    expect(store.saveWindowAppearance('holder', { name: 'Output', color: null })).toBe(true)

    expect(reopen().listExtraWindows().holder).toMatchObject({
      layout: '{"holder":1}',
      bounds: holderBounds,
      name: 'Output',
      closed: true,
    })
    expect(reopen().loadWindowAppearance('holder').color).toBe(null)
  })

  it('stores a layout and reads it back', () => {
    const { store, stateFile } = fixture()
    store.saveLayout('main', '{"grid":{"root":1}}')
    expect(existsSync(stateFile)).toBe(true)
    expect(store.loadLayout('main')).toEqual({ layout: '{"grid":{"root":1}}', failed: false })
  })

  it('leaves no temporary file behind, so the write landed through a rename', () => {
    const { store, stateFile } = fixture()
    store.saveLayout('main', '{"generation":1}')
    expect(existsSync(`${stateFile}.tmp`)).toBe(false)
  })

  it('keeps the previous version in snapshots when a layout is replaced', () => {
    const { store, stateFile, snapshotsDirectory } = fixture()
    store.saveLayout('main', '{"generation":1}')
    store.saveLayout('main', '{"generation":2}')
    const snapshots = snapshotNames(snapshotsDirectory)
    expect(snapshots).toHaveLength(1)
    expect(documentIn(join(snapshotsDirectory, snapshots[0])).layout).toBe('{"generation":1}')
    expect(documentIn(stateFile).layout).toBe('{"generation":2}')
  })

  it('keeps ten snapshots after twelve writes', () => {
    const { store, snapshotsDirectory } = fixture()
    for (let generation = 1; generation <= 12; generation += 1)
      store.saveLayout('main', `{"generation":${generation}}`)
    expect(snapshotNames(snapshotsDirectory)).toHaveLength(10)
  })

  it('prunes the oldest snapshots, never the newest', () => {
    const { store, snapshotsDirectory } = fixture()
    for (let generation = 1; generation <= 12; generation += 1)
      store.saveLayout('main', `{"generation":${generation}}`)
    const layouts = snapshotNames(snapshotsDirectory)
      .sort()
      .map((name) => documentIn(join(snapshotsDirectory, name)).layout)
    expect(layouts[0]).toBe('{"generation":2}')
    expect(layouts[layouts.length - 1]).toBe('{"generation":11}')
  })

  // Ten drags of the window would otherwise spend all ten recovery points on window positions.
  it('spends no snapshot on a window bounds write', () => {
    const { store, snapshotsDirectory } = fixture()
    store.saveLayout('main', '{"generation":1}')
    for (let move = 0; move < 12; move += 1)
      store.saveWindowBounds('main', { ...boundsFixtureConst, x: 100 + move })
    expect(snapshotNames(snapshotsDirectory)).toEqual([])
  })

  it('still snapshots the layout that a bounds write left in the file', () => {
    const { store, snapshotsDirectory, stateFile } = fixture()
    store.saveLayout('main', '{"generation":1}')
    store.saveWindowBounds('main', boundsFixtureConst)
    store.saveLayout('main', '{"generation":2}')
    const snapshots = snapshotNames(snapshotsDirectory)
    expect(snapshots).toHaveLength(1)
    expect(documentIn(join(snapshotsDirectory, snapshots[0])).windowBounds)
      .toEqual(boundsFixtureConst)
    expect(documentIn(stateFile).layout).toBe('{"generation":2}')
  })

  // The per-process counter restarted at zero in every run, so two runs snapshotting in the same
  // millisecond wrote one name and the copy silently replaced the older snapshot.
  it('keeps the snapshots of two runs that write in the same millisecond', () => {
    const { store, snapshotsDirectory, reopen } = fixture()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T10:00:00.000Z'))
    store.saveLayout('main', '{"generation":1}')
    store.saveLayout('main', '{"generation":2}')

    reopen().saveLayout('main', '{"generation":3}')

    expect(snapshotNames(snapshotsDirectory)).toHaveLength(2)
  })

  it('refuses a layout that is not JSON and leaves the stored one on disk', () => {
    const { store, stateFile } = fixture()
    store.saveLayout('main', '{"generation":1}')
    expect(() => store.saveLayout('main', '{"grid": ')).toThrow(/not JSON/)
    expect(documentIn(stateFile).layout).toBe('{"generation":1}')
    expect(store.loadLayout('main').layout).toBe('{"generation":1}')
  })

  it('reports a damaged state file as failed and never deletes it', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(stateFile, '{ "schemaVersion": 1, "layout"', 'utf8')
    expect(store.loadLayout('main')).toEqual({ layout: null, failed: true })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/unreadable/)
    expect(readFileSync(stateFile, 'utf8')).toBe('{ "schemaVersion": 1, "layout"')
  })

  // Rule 4 on the writer's side: the renderer latches on a failed read, and so does the store it
  // latches for. Storing bounds alone used to replace the damaged file with a document that had no
  // layout key at all, which is the workspace loss the latch exists to prevent.
  it('writes nothing at all once the stored state could not be read', () => {
    const { store, stateFile, snapshotsDirectory } = fixture()
    const damagedConst = '{ "schemaVersion": 1, "layout"'
    writeFileSync(stateFile, damagedConst, 'utf8')

    expect(store.saveLayout('main', '{"generation":1}')).toBe(false)
    store.saveWindowBounds('main', boundsFixtureConst)

    expect(readFileSync(stateFile, 'utf8')).toBe(damagedConst)
    expect(snapshotNames(snapshotsDirectory)).toEqual([])
    expect(store.loadLayout('main')).toEqual({ layout: null, failed: true })
    expect(store.loadWindowBounds('main')).toBeNull()
  })

  it('explains the refused writes once, not once per window drag', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(stateFile, '{ "schemaVersion": 1, "layout"', 'utf8')

    for (let move = 0; move < 5; move += 1)
      store.saveWindowBounds('main', { ...boundsFixtureConst, x: 100 + move })

    expect(reports.filter((message) => /nothing is written/.test(message))).toHaveLength(1)
  })

  // The validation runs before the latch is consulted, so a caller still learns its input was bad.
  it('still refuses a layout that is not JSON after a failed read', () => {
    const { store, stateFile } = fixture()
    writeFileSync(stateFile, '{ "schemaVersion": 1, "layout"', 'utf8')
    expect(() => store.saveLayout('main', '{"grid": ')).toThrow(/not JSON/)
  })

  it('treats a document of an unknown schema version as damaged', () => {
    const { store, stateFile } = fixture()
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: 3, layout: '{}' }), 'utf8')
    expect(store.loadLayout('main')).toEqual({ layout: null, failed: true })
  })

  it('latches on a non-string layout nested under an extra window', () => {
    const { store, stateFile } = fixture()
    const damaged = JSON.stringify({
      schemaVersion: 2,
      layout: '{"main":1}',
      extraWindows: { holder: { layout: { grid: true } } },
    })
    writeFileSync(stateFile, damaged, 'utf8')

    expect(store.loadLayout('main')).toEqual({ layout: null, failed: true })
    expect(store.saveLayout('holder', '{"holder":2}')).toBe(false)
    expect(readFileSync(stateFile, 'utf8')).toBe(damaged)
  })

  it('latches on a structurally invalid extra-windows collection or entry', () => {
    for (const extraWindows of [[], { holder: [] }]) {
      const { store, stateFile } = fixture()
      writeFileSync(stateFile, JSON.stringify({ schemaVersion: 2, extraWindows }), 'utf8')

      expect(store.loadLayout('main')).toEqual({ layout: null, failed: true })
    }
  })

  it('drops damaged bounds and appearance leaves without losing an extra layout', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 2,
      layout: '{"main":1}',
      mainWindow: { name: 7, color: '#123456' },
      extraWindows: {
        holder: {
          layout: '{"holder":1}',
          bounds: { ...boundsFixtureConst, width: 'wide' },
          name: false,
          color: [],
          closed: false,
        },
      },
    }), 'utf8')

    expect(store.loadLayout('main')).toEqual({ layout: '{"main":1}', failed: false })
    expect(store.loadLayout('holder')).toEqual({ layout: '{"holder":1}', failed: false })
    expect(store.loadWindowBounds({ extraWindowId: 'holder' })).toBeNull()
    expect(store.loadWindowAppearance('main')).toEqual({ name: null, color: '#123456' })
    expect(store.loadWindowAppearance('holder')).toEqual({ name: null, color: null })
    expect(store.listExtraWindows().holder).toEqual({ layout: '{"holder":1}' })
    expect(reports).toHaveLength(5)
  })

  // `WindowIcon.of` throws on a colour off `#rrggbb`, and it runs while the FIRST window is
  // being built - before any window exists to report into and with nothing on that path to
  // catch. A hand-edited file with `"red"` in it used to end the boot silently: no window, no
  // message, a process the user has to kill. A shape this layer cannot use is dropped here.
  it('drops a stored colour that is not a six-digit hex, rather than handing it on', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 2,
      mainWindow: { name: 'Main', color: 'red' },
      extraWindows: {
        holder: { name: 'Holder', color: '#ABCDEF', closed: false },
      },
    }), 'utf8')

    expect(store.loadWindowAppearance('main')).toEqual({ name: 'Main', color: null })
    // Upper case is a colour the write path would have accepted and lowercased, so it survives.
    expect(store.loadWindowAppearance('holder')).toEqual({ name: 'Holder', color: '#ABCDEF' })
    expect(reports.some((message) => message.includes('color is invalid'))).toBe(true)
  })

  it('stores the window bounds beside the layout in one file', () => {
    const { store, stateFile } = fixture()
    store.saveLayout('main', '{"generation":1}')
    store.saveWindowBounds('main', boundsFixtureConst)
    expect(store.loadWindowBounds('main')).toEqual(boundsFixtureConst)
    expect(documentIn(stateFile).layout).toBe('{"generation":1}')
    expect(documentIn(stateFile).windowBounds).toEqual(boundsFixtureConst)
  })

  it('refuses bounds that are not whole finite numbers', () => {
    const { store } = fixture()
    expect(() => store.saveWindowBounds('main', { ...boundsFixtureConst, width: Number.NaN }))
      .toThrow(/Refusing to store window bounds/)
    expect(() => store.saveWindowBounds('main', { ...boundsFixtureConst, height: 0 }))
      .toThrow(/Refusing to store window bounds/)
    expect(() => store.saveWindowBounds('main', { ...boundsFixtureConst, x: 12.5 }))
      .toThrow(/Refusing to store window bounds/)
  })

  // Two windows, two rectangles, one file. The main window keeps the field it has always had, so a
  // state file written before the Debug window existed still opens with its own placement.
  it('keeps each window bounds under its own key', () => {
    const { store, stateFile, reopen } = fixture()
    const debugBounds: WindowBounds = { x: 40, y: 40, width: 1100, height: 760, maximized: false }
    store.saveWindowBounds('main', boundsFixtureConst)
    store.saveWindowBounds('debug', debugBounds)

    expect(store.loadWindowBounds('main')).toEqual(boundsFixtureConst)
    expect(store.loadWindowBounds('debug')).toEqual(debugBounds)
    expect(documentIn(stateFile).windowBounds).toEqual(boundsFixtureConst)

    const reopened = reopen()
    expect(reopened.loadWindowBounds('main')).toEqual(boundsFixtureConst)
    expect(reopened.loadWindowBounds('debug')).toEqual(debugBounds)
  })

  it('stores a holder layout with snapshots but spends none on its bounds or appearance', () => {
    const { store, snapshotsDirectory } = fixture()
    expect(store.markExtraWindowOpen('holder')).toBe(true)
    expect(store.saveLayout('holder', '{"generation":1}')).toBe(true)
    expect(snapshotNames(snapshotsDirectory)).toHaveLength(1)

    expect(store.saveWindowBounds(
      { extraWindowId: 'holder' },
      boundsFixtureConst,
    )).toBe(true)
    expect(store.saveWindowAppearance('holder', { name: 'Logs', color: '#123456' })).toBe(true)
    expect(snapshotNames(snapshotsDirectory)).toHaveLength(1)

    expect(store.saveLayout('holder', '{"generation":2}')).toBe(true)
    expect(snapshotNames(snapshotsDirectory)).toHaveLength(2)
  })

  it('clears exactly one window layout through the only legal empty-layout path', () => {
    const { store, snapshotsDirectory } = fixture()
    store.saveLayout('main', '{"main":1}')
    store.markExtraWindowOpen('holder')
    store.saveLayout('holder', '{"holder":1}')
    const beforeClear = snapshotNames(snapshotsDirectory).length

    expect(store.clearLayout('holder')).toBe(true)
    expect(store.loadLayout('holder').layout).toBe(null)
    expect(store.loadLayout('main').layout).toBe('{"main":1}')
    expect(snapshotNames(snapshotsDirectory)).toHaveLength(beforeClear + 1)

    expect(store.clearLayout('main')).toBe(true)
    expect(store.loadLayout('main').layout).toBe(null)
    expect(() => store.saveLayout('main', '')).toThrow(/not JSON/)
  })

  it('keeps a named closed window and garbage-collects an unnamed one', () => {
    const { store } = fixture()
    store.markExtraWindowOpen('named')
    store.saveLayout('named', '{"named":1}')
    store.saveWindowAppearance('named', { name: 'Logs', color: null })
    store.markExtraWindowOpen('plain')
    store.saveLayout('plain', '{"plain":1}')

    expect(store.markExtraWindowClosed('named')).toBe(true)
    expect(store.isNamed('named')).toBe(true)
    expect(store.listExtraWindows().named).toMatchObject({
      name: 'Logs',
      layout: '{"named":1}',
      closed: true,
    })

    expect(store.markExtraWindowClosed('plain')).toBe(true)
    expect(store.isNamed('plain')).toBe(false)
    expect(store.listExtraWindows().plain).toBeUndefined()

    expect(store.markExtraWindowOpen('named')).toBe(true)
    expect(store.listExtraWindows().named.closed).toBeUndefined()
  })

  it('refuses writes for an extra window that was never registered', () => {
    const { store, reports } = fixture()

    expect(store.saveLayout('missing', '{"holder":1}')).toBe(false)
    expect(store.saveWindowBounds({ extraWindowId: 'missing' }, boundsFixtureConst)).toBe(false)
    expect(store.saveWindowAppearance('missing', { name: 'Logs', color: null })).toBe(false)
    expect(reports).toHaveLength(3)
    expect(reports.every((message) => message.includes('no extra window'))).toBe(true)
  })

  it('reads a file written before the Debug window existed', () => {
    const { store, stateFile } = fixture()
    writeFileSync(
      stateFile,
      JSON.stringify({ schemaVersion: 1, windowBounds: boundsFixtureConst }),
      'utf8',
    )
    expect(store.loadWindowBounds('main')).toEqual(boundsFixtureConst)
    expect(store.loadWindowBounds('debug')).toBeNull()
  })

  // Losing a window position is cheap; failing the whole read over one would cost the layout.
  it('drops damaged Debug bounds and keeps the rest of the document', () => {
    const { store, stateFile } = fixture()
    writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        layout: '{"generation":1}',
        windowBounds: boundsFixtureConst,
        debugWindowBounds: { x: 0, y: 0, width: 'wide', height: 760, maximized: false },
      }),
      'utf8',
    )
    expect(store.loadWindowBounds('debug')).toBeNull()
    expect(store.loadWindowBounds('main')).toEqual(boundsFixtureConst)
    expect(store.loadLayout('main')).toEqual({ layout: '{"generation":1}', failed: false })
  })

  it('stores the sidebar state beside the layout and reads it back', () => {
    const { store, stateFile, reopen } = fixture()
    const sidebars = SidebarsState.withWidth(SidebarsState.default(), 'left', 300)
    store.saveLayout('main', '{"generation":1}')
    store.saveSidebars(sidebars)
    expect(documentIn(stateFile).layout).toBe('{"generation":1}')
    expect(reopen().loadSidebars()).toEqual({ sidebars, failed: false })
  })

  // The ten recovery points belong to layouts. A splitter drag would otherwise empty the ring.
  it('spends no snapshot on a sidebar write', () => {
    const { store, snapshotsDirectory } = fixture()
    store.saveLayout('main', '{"generation":1}')
    store.saveLayout('main', '{"generation":2}')
    const afterLayouts = snapshotNames(snapshotsDirectory).length
    for (let width = 200; width < 240; width += 1)
      store.saveSidebars(SidebarsState.withWidth(SidebarsState.default(), 'left', width))
    expect(snapshotNames(snapshotsDirectory)).toHaveLength(afterLayouts)
  })

  // Handed RAW, not through SidebarsState.coerce: the helper clamped the value before the store
  // ever saw it, so the assertion was answered by the test itself and `saveSidebars` without any
  // validation passed the whole suite.
  it('refuses a sidebar payload that is not shape-valid, like its two sibling writers', () => {
    const { store, stateFile } = fixture()
    store.saveSidebars(SidebarsState.default())
    const damaged = {
      left: { visible: true, width: 10_000, activeView: null },
      right: { visible: false, width: 260, activeView: null },
    } as SidebarsStateValue

    expect(() => store.saveSidebars(damaged)).toThrow(/Refusing to store sidebar state/)
    expect(() => store.saveSidebars({ left: 'wide' } as unknown as SidebarsStateValue))
      .toThrow(/Refusing to store sidebar state/)
    expect(documentIn(stateFile).sidebars).toEqual(SidebarsState.default())
  })

  // The refusal used to compare JSON text, so the same data with its keys in another order was
  // called damaged - a shape check has to look at the fields.
  it('stores a valid payload whatever order its keys arrive in', () => {
    const { store } = fixture()
    const reordered = {
      right: { activeView: null, width: 300, visible: true },
      left: { width: 200, activeView: 'probeLeft', visible: false },
    } as unknown as SidebarsStateValue

    store.saveSidebars(reordered)

    expect(store.loadSidebars().sidebars).toEqual({
      left: { visible: false, width: 200, activeView: 'probeLeft' },
      right: { visible: true, width: 300, activeView: null },
    })
  })

  // A key of its own beside the sidebars, so the two cadences cannot overwrite each other: the
  // sidebar width arrives on every drag of the splitter and this arrives on a press of a button.
  it('stores the sessions view under its own key and reads it back', () => {
    const { store, stateFile, reopen } = fixture()
    store.saveSidebars(SidebarsState.default())
    store.saveSessionsView('together')

    const document = documentIn(stateFile)
    expect(document.sessionsView).toBe('together')
    expect(document.sidebars).toEqual(SidebarsState.default())
    expect(reopen().loadSessionsView()).toEqual({ sessionsView: 'together' })
  })

  it('answers null for a sessions view nobody has stored yet', () => {
    const { store } = fixture()
    expect(store.loadSessionsView()).toEqual({ sessionsView: null })
  })

  it('round-trips the last New Session agent without spending a layout snapshot', () => {
    const { store, stateFile, snapshotsDirectory, reopen } = fixture()

    expect(store.loadNewSessionAgent()).toBe('claude')
    expect(store.saveNewSessionAgent('codex')).toBe(true)

    expect(documentIn(stateFile).newSessionAgent).toBe('codex')
    expect(reopen().loadNewSessionAgent()).toBe('codex')
    expect(snapshotNames(snapshotsDirectory)).toEqual([])
  })

  it('drops an invalid stored New Session agent without losing the rest of the state', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 2,
      layout: '{"generation":1}',
      newSessionAgent: 'gpt',
    }), 'utf8')

    expect(store.loadNewSessionAgent()).toBe('claude')
    expect(store.loadLayout('main')).toEqual({ layout: '{"generation":1}', failed: false })
    expect(reports.filter((message) => /new-session agent is invalid/.test(message))).toHaveLength(1)
    expect(() => store.saveNewSessionAgent('gpt' as never)).toThrow(/Refusing to store/)
  })

  it('refuses a sessions view it was never taught, like its sibling writers', () => {
    const { store, stateFile } = fixture()
    store.saveSessionsView('separated')

    expect(() => store.saveSessionsView('sideways' as never))
      .toThrow(/Refusing to store the sessions view/)
    expect(documentIn(stateFile).sessionsView).toBe('separated')
  })

  // How the panel LOOKS, not what it holds: a value nothing recognises costs one press of a button,
  // where failing the read would cost the layout stored beside it.
  it('reads a damaged sessions view as the default, reports it, and keeps the rest', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(
      stateFile,
      JSON.stringify({ schemaVersion: 1, layout: '{"generation":1}', sessionsView: 'sideways' }),
      'utf8',
    )

    expect(store.loadSessionsView()).toEqual({ sessionsView: 'separated' })
    expect(store.loadLayout('main')).toEqual({ layout: '{"generation":1}', failed: false })
    expect(reports.filter((message) => /is not a view/.test(message))).toHaveLength(1)
  })

  it('says nothing about a file that simply carries no sessions view', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, layout: '{}' }), 'utf8')

    expect(store.loadSessionsView()).toEqual({ sessionsView: null })
    expect(reports).toEqual([])
  })

  it('refuses a layout that parses but is not an object', () => {
    const { store, stateFile } = fixture()
    store.saveLayout('main', '{"generation":1}')
    for (const layout of ['null', '[]', '"x"', '42'])
      expect(() => store.saveLayout('main', layout)).toThrow(/not an object/)
    expect(documentIn(stateFile).layout).toBe('{"generation":1}')
  })

  it('falls back to the default sidebar state instead of failing a read on a damaged one', () => {
    const { store, stateFile } = fixture()
    writeFileSync(
      stateFile,
      JSON.stringify({ schemaVersion: 1, layout: '{"generation":1}', sidebars: 'wide' }),
      'utf8',
    )
    expect(store.loadSidebars()).toEqual({ sidebars: SidebarsState.default(), failed: false })
    expect(store.loadLayout('main')).toEqual({ layout: '{"generation":1}', failed: false })
  })

  // The other half of the latch: the renderer stops, and the store refuses even if it did not.
  it('refuses a sidebar write after a read that failed', () => {
    const { store, stateFile, reports } = fixture()
    writeFileSync(stateFile, '{ not json', 'utf8')
    store.saveSidebars(SidebarsState.default())
    expect(readFileSync(stateFile, 'utf8')).toBe('{ not json')
    // The renderer latches on this answer; without it the two-layer defence is silently one layer.
    expect(store.loadSidebars()).toEqual({ sidebars: null, failed: true })
    expect(reports.some((message) => /nothing is written/.test(message))).toBe(true)
  })

  it('opens a document written by a newer build instead of refusing the whole read', () => {
    const { store, stateFile } = fixture()
    writeFileSync(
      stateFile,
      JSON.stringify({ schemaVersion: 1, layout: '{"generation":1}', panelDock: { future: true } }),
      'utf8',
    )
    expect(store.loadLayout('main')).toEqual({ layout: '{"generation":1}', failed: false })
  })

  // Losing a layout is expensive, losing a window position is not: only the bounds are dropped.
  it('drops unusable stored bounds without failing the layout read', () => {
    const { store, stateFile } = fixture()
    writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        layout: '{"generation":1}',
        windowBounds: { x: 0, y: 0, width: -4000, height: 900, maximized: false },
      }),
      'utf8',
    )
    expect(store.loadWindowBounds('main')).toBeNull()
    expect(store.loadLayout('main')).toEqual({ layout: '{"generation":1}', failed: false })
  })
})
