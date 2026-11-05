import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    notices: [] as { title: string; body: string }[],
    errors: [] as { title: string; body: string }[],
    noticeFails: false,
    cacheCleared: 0,
    handlers: new Map<string, (event: { preventDefault(): void }) => void>(),
    ready: new Promise<void>(() => {}),
    app: {
      isPackaged: false,
      getVersion: () => '0.0.0',
      getAppPath: () => 'C:/fixture/app-client-ui',
      setPath(name: string, value: string): void {
        electronMock.calls.push(`setPath:${name}`)
        electronMock.userDataPath = value
      },
      requestSingleInstanceLock(): boolean {
        electronMock.calls.push('requestSingleInstanceLock')
        return electronMock.lockGranted
      },
      setAppUserModelId: () => undefined,
      quit(): void {
        electronMock.calls.push('quit')
      },
      exit(): void {
        electronMock.calls.push('exit')
      },
      on(event: string, handler: (event: { preventDefault(): void }) => void): void {
        electronMock.handlers.set(event, handler)
      },
      whenReady(): Promise<void> {
        electronMock.calls.push('whenReady')
        return electronMock.ready
      },
    },
  },
  hubMock: { calls: [] as string[], initialize: () => Promise.resolve(), dispose: () => Promise.resolve(),
    restart: () => Promise.resolve(true), onChildExit: (_kind: 'gateway' | 'orchestrator') => {} },
}))

vi.mock('./appHub', () => ({
  MainHub: class {
    constructor(_context: unknown, onChildExit: typeof hubMock.onChildExit) { hubMock.onChildExit = onChildExit }
    initialize(): Promise<void> { hubMock.calls.push('initialize'); return hubMock.initialize() }
    focusWindow(): void { hubMock.calls.push('focusWindow') }
    runSmoke(): void { hubMock.calls.push('runSmoke') }
    beginQuit(): void { hubMock.calls.push('beginQuit') }
    dispose(): Promise<void> { hubMock.calls.push('dispose'); return hubMock.dispose() }
    async restart(): Promise<boolean> {
      hubMock.calls.push('restart')
      const started = await hubMock.restart()
      if (started) electronMock.app.quit()
      return started
    }
  },
}))

vi.mock('electron', () => ({
  app: electronMock.app,
  Notification: class {
    private readonly options: { title: string; body: string }
    constructor(options: { title: string; body: string }) { this.options = options }
    show(): void {
      if (electronMock.noticeFails) throw new Error('notice failed')
      electronMock.notices.push(this.options)
    }
  },
  dialog: { showErrorBox: (title: string, body: string) => { electronMock.errors.push({ title, body }) } },
  session: { defaultSession: { clearCache: () => { electronMock.cacheCleared += 1; return Promise.resolve() } } },
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
    electronMock.notices = []
    electronMock.errors = []
    electronMock.noticeFails = false
    electronMock.cacheCleared = 0
    electronMock.handlers.clear()
    electronMock.ready = new Promise<void>(() => {})
    hubMock.calls = []
    hubMock.initialize = () => Promise.resolve()
    hubMock.dispose = () => Promise.resolve()
    hubMock.restart = () => Promise.resolve(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('clears the HTTP cache before the hub starts only when a dev server serves the renderer', async () => {
    electronMock.ready = Promise.resolve()
    const previous = process.env.ELECTRON_RENDERER_URL
    try {
      delete process.env.ELECTRON_RENDERER_URL
      await AppClientUi.run(import.meta.url)
      expect(electronMock.cacheCleared).toBe(0)
      process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
      hubMock.initialize = () => { expect(electronMock.cacheCleared).toBe(1); return Promise.resolve() }
      await AppClientUi.run(import.meta.url)
      expect(electronMock.cacheCleared).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = previous
    }
  })

  it('raises the window quit latch before disposing the hub', async () => {
    electronMock.ready = Promise.resolve()
    await AppClientUi.run(import.meta.url)

    const preventDefault = vi.fn()
    electronMock.handlers.get('before-quit')?.({ preventDefault })
    await Promise.resolve()

    expect(hubMock.calls).toEqual(['initialize', 'beginQuit', 'dispose'])
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it.each([
    { args: ['--smoke'], smokeRuns: 1 },
    { args: ['--smoke', '--smoke-driver'], smokeRuns: 0 },
    { args: ['--smoke-driver'], smokeRuns: 0 },
  ])('preserves smoke lifecycle for $args', async ({ args, smokeRuns }) => {
    const argv = process.argv
    process.argv = [...argv, ...args]
    try {
      electronMock.ready = Promise.resolve()
      await AppClientUi.run(import.meta.url)
      expect(hubMock.calls.filter(call => call === 'runSmoke')).toHaveLength(smokeRuns)
    } finally { process.argv = argv }
  })

  it('queues second-instance focus until asynchronous child initialization completes', async () => {
    electronMock.ready = Promise.resolve()
    let initialized!: () => void
    hubMock.initialize = () => new Promise<void>(resolve => { initialized = resolve })
    const running = AppClientUi.run(import.meta.url)
    await vi.waitFor(() => expect(hubMock.calls).toEqual(['initialize']))
    electronMock.handlers.get('second-instance')?.({ preventDefault() {} })
    expect(hubMock.calls).toEqual(['initialize'])
    initialized()
    await running
    expect(hubMock.calls).toEqual(['initialize', 'focusWindow'])
  })

  it('does not focus after quit starts while child initialization is pending', async () => {
    electronMock.ready = Promise.resolve()
    let initialized!: () => void
    hubMock.initialize = () => new Promise<void>(resolve => { initialized = resolve })
    const running = AppClientUi.run(import.meta.url)
    await vi.waitFor(() => expect(hubMock.calls).toEqual(['initialize']))
    electronMock.handlers.get('second-instance')?.({ preventDefault() {} })
    electronMock.handlers.get('before-quit')?.({ preventDefault() {} })
    initialized()
    await running
    expect(hubMock.calls).toEqual(['initialize', 'beginQuit', 'dispose'])
  })

  it('drains once before relaunch, suppresses a sibling crash, and limits later generations', async () => {
    let at = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => at)
    electronMock.ready = Promise.resolve()
    await AppClientUi.run(import.meta.url)
    let disposed!: () => void
    hubMock.dispose = () => new Promise<void>(resolve => { disposed = resolve })
    hubMock.onChildExit('gateway')
    hubMock.onChildExit('orchestrator')
    expect(hubMock.calls).toEqual(['initialize', 'beginQuit', 'dispose'])
    expect(electronMock.notices).toHaveLength(1)
    const marker = join(stateDirectory(), 'child-relaunch.json')
    expect(existsSync(marker)).toBe(false)
    expect(electronMock.calls).not.toContain('quit')
    expect(electronMock.calls).not.toContain('exit')
    at += 5_000
    disposed()
    await vi.waitFor(() => expect(hubMock.calls.at(-1)).toBe('restart'))
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ at: 100_000 })
    expect(electronMock.errors).toEqual([])

    at = 130_000
    hubMock.calls = []
    hubMock.dispose = () => Promise.resolve()
    await AppClientUi.run(import.meta.url)
    hubMock.onChildExit('gateway')
    await vi.waitFor(() => expect(electronMock.errors).toHaveLength(1))
    expect(hubMock.calls).toEqual(['initialize', 'beginQuit', 'dispose'])
    expect(electronMock.errors[0].title).toBe('Jamat stopped after repeated crashes')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ at: 100_000 })

    at = 190_000
    hubMock.calls = []
    await AppClientUi.run(import.meta.url)
    hubMock.onChildExit('gateway')
    await vi.waitFor(() => expect(hubMock.calls.at(-1)).toBe('restart'))
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ at: 190_000 })
    expect(electronMock.notices).toHaveLength(2)
  })

  it.each([false, true])('keeps the crash-policy outcome after the full bounded drain, repeated=%s', async repeated => {
    vi.useFakeTimers()
    try {
      electronMock.ready = Promise.resolve()
      await AppClientUi.run(import.meta.url)
      const marker = join(stateDirectory(), 'child-relaunch.json')
      if (repeated) writeFileSync(marker, JSON.stringify({ at: Date.now() - 20_000 }))
      hubMock.dispose = () => new Promise<void>(resolve => {
        setTimeout(() => { hubMock.calls.push('gateway-stop'); setTimeout(resolve, 3_000) }, 15_000)
      })
      hubMock.onChildExit('gateway')
      await vi.advanceTimersByTimeAsync(17_999)
      expect(hubMock.calls).not.toContain('restart')
      expect(electronMock.calls).not.toContain('exit')
      await vi.advanceTimersByTimeAsync(1)
      expect(hubMock.calls).toContain('gateway-stop')
      expect(electronMock.calls).not.toContain('exit')
      if (repeated) {
        expect(hubMock.calls).not.toContain('restart')
        expect(electronMock.errors[0]?.title).toBe('Jamat stopped after repeated crashes')
      } else {
        expect(hubMock.calls.at(-1)).toBe('restart')
        expect(existsSync(marker)).toBe(true)
      }
      expect(electronMock.calls.at(-1)).toBe('quit')
    } finally { vi.useRealTimers() }
  })

  it('allows Electron final quit only after disposal and does not start another drain', async () => {
    electronMock.ready = Promise.resolve()
    await AppClientUi.run(import.meta.url)
    let disposed!: () => void
    hubMock.dispose = () => new Promise<void>(resolve => { disposed = resolve })
    const preventDefault = vi.fn()
    electronMock.handlers.get('before-quit')?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(electronMock.calls).not.toContain('quit')
    disposed()
    await vi.waitFor(() => expect(electronMock.calls.at(-1)).toBe('quit'))
    const finalPrevent = vi.fn()
    electronMock.handlers.get('before-quit')?.({ preventDefault: finalPrevent })
    expect(finalPrevent).not.toHaveBeenCalled()
    expect(hubMock.calls).toEqual(['initialize', 'beginQuit', 'dispose'])
    expect(electronMock.calls).not.toContain('exit')
  })

  it('exits immediately on a second explicit quit while normal disposal is pending', async () => {
    electronMock.ready = Promise.resolve()
    await AppClientUi.run(import.meta.url)
    let disposed!: () => void
    hubMock.dispose = () => new Promise<void>(resolve => { disposed = resolve })
    electronMock.handlers.get('before-quit')?.({ preventDefault() {} })
    expect(electronMock.calls).not.toContain('exit')
    electronMock.handlers.get('before-quit')?.({ preventDefault() {} })
    expect(electronMock.calls.at(-1)).toBe('exit')
    expect(hubMock.calls).toEqual(['initialize', 'beginQuit', 'dispose'])
    disposed()
    await vi.waitFor(() => expect(electronMock.calls.at(-1)).toBe('quit'))
  })

  it.each(['notice', 'marker', 'restart'] as const)('still drains and quits when %s fails', async failure => {
    electronMock.ready = Promise.resolve()
    await AppClientUi.run(import.meta.url)
    if (failure === 'notice') electronMock.noticeFails = true
    else if (failure === 'marker') writeFileSync(join(stateDirectory(), 'child-relaunch.json'), 'invalid')
    else if (failure === 'restart') hubMock.restart = () => Promise.reject(new Error('restart failed'))
    else throw new Error(`Unknown failure: ${failure}`)
    hubMock.onChildExit('gateway')
    await vi.waitFor(() => expect(electronMock.errors).toHaveLength(1))
    expect(hubMock.calls.slice(0, 3)).toEqual(['initialize', 'beginQuit', 'dispose'])
    expect(electronMock.errors[0].title).toBe('Jamat could not restart')
    expect(electronMock.calls.at(-1)).toBe('quit')
  })
})
