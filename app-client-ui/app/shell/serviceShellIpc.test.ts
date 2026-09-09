import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AppClientUiIpcInvokeMap,
  AppInfo,
  IpcResult,
  LoadLayoutResult,
  LoadSessionsViewResult,
  LoadSidebarsResult,
} from '../../shared/appClientUiIpc'
import { SidebarsState } from '../../shared/sidebarsState'
import { ClientStateStore } from '../clientState/clientStateStore'
import { ServiceShellIpc } from './serviceShellIpc'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const { ipcMainMock } = vi.hoisted(() => ({
  ipcMainMock: {
    handlers: new Map<string, IpcHandler>(),
    handle(channel: string, handler: IpcHandler): void {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

vi.mock('electron', () => ({
  ipcMain: ipcMainMock,
  ipcRenderer: { invoke: () => Promise.resolve(), on: () => {}, removeListener: () => {} },
}))

describe('app-client-ui/app/shell/serviceShellIpc', () => {
  const appInfoConst: AppInfo = {
    appVersion: '0.0.0',
    platform: 'win32',
    configDir: join('C:', 'config'),
    configIdentity: '3f6a2c1e-0b7d-4a5f-9c11-4d2e6b8a0f31',
    runtimeChannel: 'development',
  }
  const created: string[] = []
  const mainSender = { id: 1 } as unknown as WebContents
  const holderSender = { id: 2 } as unknown as WebContents
  const unknownSender = { id: 3 } as unknown as WebContents
  const ready: WebContents[] = []
  let stateFile: string
  let store: ClientStateStore
  let service: ServiceShellIpc

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-ipc-'))
    created.push(directory)
    stateFile = join(directory, 'client-state.json')
    ready.length = 0
    store = new ClientStateStore(
      stateFile,
      join(directory, 'snapshots'),
      () => {},
    )
    service = new ServiceShellIpc(
      appInfoConst,
      store,
      (sender) => sender === holderSender ? 'holder' : sender === mainSender ? 'main' : null,
      (sender) => ready.push(sender),
    )
  })

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  async function invoke(channel: keyof AppClientUiIpcInvokeMap, ...args: unknown[]): Promise<unknown> {
    return invokeFrom(mainSender, channel, ...args)
  }

  it('routes saved filters through the main window and refuses other writers', async () => {
    service.initialize()
    const filters = [{ id: 'work', name: 'Work', filterText: 'Jamat',
      filters: { colors: ['red'], states: ['running'], agents: ['claude'] } }]
    expect(await invoke('state:save-session-filters', filters)).toEqual({ ok: true, value: true })
    expect(await invoke('state:load-session-filters')).toEqual({ ok: true, value: filters })
    expect(await invokeFrom(holderSender, 'state:save-session-filters', [])).toMatchObject({ ok: false })
    expect(await invokeFrom(unknownSender, 'state:load-session-filters')).toMatchObject({ ok: false })
    expect(await invoke('state:save-session-filters', [null])).toMatchObject({ ok: false })
    expect(store.loadSessionFilters()).toEqual(filters)
  })

  async function invokeFrom(
    sender: WebContents,
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender }, ...args)
  }

  // That the subsets add up to the whole contract is AppHub's job now; this is the runtime half of
  // the shell's own share.
  it('registers a handler for every channel it declares', () => {
    service.initialize()
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceShellIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = service as unknown as {
      assertComplete(channels: typeof ServiceShellIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceShellIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('refuses to register the same channel twice', () => {
    service.initialize()
    const internals = service as unknown as {
      register(channel: keyof AppClientUiIpcInvokeMap, handler: () => void): void
    }
    expect(() => internals.register('app:info', () => {}))
      .toThrow(/IPC channel is already registered/)
  })

  it('answers app:info with the process facts', async () => {
    service.initialize()
    expect(await invoke('app:info')).toEqual({ ok: true, value: appInfoConst })
  })

  it('round-trips a layout through the store', async () => {
    service.initialize()
    expect(await invoke('state:save-layout', '{"generation":1}'))
      .toEqual({ ok: true, value: true })
    const loaded = await invoke('state:load-layout') as IpcResult<LoadLayoutResult>
    expect(loaded).toEqual({ ok: true, value: { layout: '{"generation":1}', failed: false } })
  })

  it('clears only the layout selected by the renderer sender', async () => {
    store.markExtraWindowOpen('holder')
    store.saveLayout('main', '{"main":1}')
    store.saveLayout('holder', '{"holder":1}')
    service.initialize()

    expect(await invokeFrom(holderSender, 'state:clear-layout'))
      .toEqual({ ok: true, value: true })
    expect(store.loadLayout('holder').layout).toBe(null)
    expect(store.loadLayout('main').layout).toBe('{"main":1}')
  })

  // The smoke run's only proof that the preload ran and the shell mounted.
  it('passes the renderer handshake to whoever is waiting for it', async () => {
    service.initialize()

    expect(await invoke('app:renderer-ready')).toEqual({ ok: true, value: undefined })
    expect(ready).toEqual([mainSender])
  })

  it('reads and writes the layout selected by the renderer sender', async () => {
    store.markExtraWindowOpen('holder')
    service.initialize()

    expect(await invokeFrom(holderSender, 'state:save-layout', '{"holder":1}'))
      .toEqual({ ok: true, value: true })
    expect(await invokeFrom(holderSender, 'state:load-layout'))
      .toEqual({ ok: true, value: { layout: '{"holder":1}', failed: false } })
    expect(store.loadLayout('main').layout).toBe(null)
  })

  // The one-window transition this used to accommodate is over: the client has held several
  // windows since, and the fallback that took an unregistered sender for main outlived its
  // reason. One preload serves the Debug window too, and that renderer is in no window
  // registry - so the accommodation meant any layout it ever wrote or cleared was the MAIN
  // window's. The two services beside this one already refuse an unknown sender.
  it('refuses a layout read or write from a sender that is in no window', async () => {
    service.initialize()
    const refusal = 'Layout state was requested by an unknown workspace renderer'

    expect(await invokeFrom(unknownSender, 'state:save-layout', '{"main":1}'))
      .toEqual({ ok: false, error: refusal })
    expect(await invokeFrom(unknownSender, 'state:clear-layout'))
      .toEqual({ ok: false, error: refusal })
    expect(await invokeFrom(unknownSender, 'state:load-layout'))
      .toEqual({ ok: false, error: refusal })
    expect(store.loadLayout('main').layout).toBe(null)
  })

  it('round-trips the sidebar state through the store', async () => {
    service.initialize()
    const sidebars = SidebarsState.withWidth(SidebarsState.default(), 'right', 320)
    // `true` is the store saying it stored it; a latched document answers `false` and the
    // renderer can tell the two apart, which is the whole reason this channel stopped being void.
    expect(await invoke('state:save-sidebars', sidebars)).toEqual({ ok: true, value: true })
    const loaded = await invoke('state:load-sidebars') as IpcResult<LoadSidebarsResult>
    expect(loaded).toEqual({ ok: true, value: { sidebars, failed: false } })
  })

  it('round-trips the sessions view through the store, on channels of its own', async () => {
    service.initialize()
    expect(await invoke('state:save-sessions-view', 'together'))
      .toEqual({ ok: true, value: true })
    const loaded = await invoke('state:load-sessions-view') as IpcResult<LoadSessionsViewResult>
    expect(loaded).toEqual({ ok: true, value: { sessionsView: 'together' } })
  })

  it('round-trips the last New Session agent through the client state store', async () => {
    service.initialize()

    expect(await invoke('state:load-new-session-agent'))
      .toEqual({ ok: true, value: 'claude' })
    expect(await invoke('state:save-new-session-agent', 'codex'))
      .toEqual({ ok: true, value: true })
    expect(await invoke('state:load-new-session-agent'))
      .toEqual({ ok: true, value: 'codex' })
  })

  // A throwing handler must reach the renderer as data, never as a rejected invoke.
  it('answers a refused layout with a failed result instead of throwing', async () => {
    service.initialize()
    const result = await invoke('state:save-layout', '{"grid": ') as IpcResult<boolean>
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok)
      expect(result.error).toMatch(/not JSON/)
  })

  it('carries a latched store refusal as a successful false result', async () => {
    writeFileSync(stateFile, '{ not json', 'utf8')
    service.initialize()

    expect(await invoke('state:save-layout', '{"generation":1}'))
      .toEqual({ ok: true, value: false })
  })
})
