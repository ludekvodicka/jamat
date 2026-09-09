import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppClientUi } from './app'
import { ClientStatePaths } from './clientState/clientStatePaths'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'

/**
 * Records the order of the calls `run` makes on the Electron app. `whenReady` never resolves, so a
 * run stops exactly where a real one would wait, and what happened before ready is what is asserted.
 */
const { electronMock, hubMock } = vi.hoisted(() => ({
  electronMock: {
    calls: [] as string[],
    userDataPath: null as string | null,
    lockGranted: true,
    handlers: new Map<string, () => void>(),
    ready: new Promise<void>(() => {}),
    app: {
      isPackaged: false,
      getVersion: () => '0.0.0',
      setPath(name: string, value: string): void {
        electronMock.calls.push(`setPath:${name}`)
        electronMock.userDataPath = value
      },
      requestSingleInstanceLock(): boolean {
        electronMock.calls.push('requestSingleInstanceLock')
        return electronMock.lockGranted
      },
      quit(): void {
        electronMock.calls.push('quit')
      },
      exit(): void {
        electronMock.calls.push('exit')
      },
      on(event: string, handler: () => void): void {
        electronMock.handlers.set(event, handler)
      },
      whenReady(): Promise<void> {
        electronMock.calls.push('whenReady')
        return electronMock.ready
      },
    },
  },
  hubMock: { calls: [] as string[] },
}))

vi.mock('./appHub', () => ({
  AppHub: class {
    initialize(): void { hubMock.calls.push('initialize') }
    focusWindow(): void { hubMock.calls.push('focusWindow') }
    runSmoke(): void { hubMock.calls.push('runSmoke') }
    beginQuit(): void { hubMock.calls.push('beginQuit') }
    async dispose(): Promise<void> { hubMock.calls.push('dispose') }
  },
}))

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  ipcMain: { handle: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {} },
  screen: { getAllDisplays: () => [] },
}))

describe('app-client-ui/app/app', () => {
  const created: string[] = []
  let configDir: string
  let stateRoot: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-app-config-'))
    stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-app-state-'))
    created.push(configDir, stateRoot)
    process.env.JAMAT_V3_CONFIG_DIR = configDir
    process.env.JAMAT_V3_LOCAL_STATE_DIR = stateRoot
    process.env.JAMAT_V3_RUNTIME_CHANNEL = 'development'
    electronMock.calls = []
    electronMock.userDataPath = null
    electronMock.lockGranted = true
    electronMock.handlers.clear()
    electronMock.ready = new Promise<void>(() => {})
    hubMock.calls = []
  })

  afterEach(() => {
    delete process.env.JAMAT_V3_CONFIG_DIR
    delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    delete process.env.JAMAT_V3_RUNTIME_CHANNEL
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function stateDirectory(): string {
    return ClientStatePaths.directory(
      ConfigIdentityStore.loadOrCreate(configDir, 'development').configIdentity,
      'development',
    )
  }

  // Electron resolves userData while it becomes ready and caches it; an override applied afterwards
  // leaves the caches in the shared default profile.
  it('redirects userData and takes the lock before Electron becomes ready', () => {
    void AppClientUi.run(import.meta.url)

    expect(electronMock.calls)
      .toEqual(['setPath:userData', 'requestSingleInstanceLock', 'whenReady'])
    expect(electronMock.userDataPath).toBe(stateDirectory())
  })

  // A second launch during this one's boot must not find an empty listener table and quit silently.
  it('listens for a second instance before it waits for ready', () => {
    void AppClientUi.run(import.meta.url)

    expect([...electronMock.handlers.keys()]).toEqual(['second-instance'])
  })

  it('creates the state directory it redirects into', () => {
    void AppClientUi.run(import.meta.url)

    expect(existsSync(stateDirectory())).toBe(true)
  })

  // Two clients on one {configIdentity, channel} are two writers of one state file, each with its
  // own cached document, and the last write wins.
  it('quits instead of becoming a second writer of the same state', async () => {
    electronMock.lockGranted = false

    await AppClientUi.run(import.meta.url)

    expect(electronMock.calls)
      .toEqual(['setPath:userData', 'requestSingleInstanceLock', 'quit'])
  })

  it('raises the window quit latch before disposing the hub', async () => {
    electronMock.ready = Promise.resolve()
    await AppClientUi.run(import.meta.url)

    electronMock.handlers.get('before-quit')?.()

    expect(hubMock.calls).toEqual(['initialize', 'beginQuit', 'dispose'])
  })
})
