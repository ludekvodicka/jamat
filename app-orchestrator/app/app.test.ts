import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestratorApp } from './app'
import type { ProcessMessage, ProcessPort } from '../../lib-orchestrator/shared/processWire.types'
import type { ShellPort } from '../../lib-orchestrator/shared/shellPort.types'
import type { WindowServiceTransport } from './ports/windowServiceTransport'

const fixture = vi.hoisted(() => ({ initialize: vi.fn(async () => {}), dispose: vi.fn(async () => true),
  quit: vi.fn(), windows: null as WindowServiceTransport | null, shell: null as ShellPort | null,
  mediaOpen: vi.fn(async () => ({ accepted: true })), mediaCancel: vi.fn(), output: [] as string[] }))
vi.mock('./appHub', () => ({ OrchestratorHub: class {
  static ipcChannelsConst = {}
  readonly api = { mediaOpen: fixture.mediaOpen, mediaCancel: fixture.mediaCancel, hostConnection() {}, hostClosed() {} }
  readonly transport = { invoke: vi.fn(), event: vi.fn() }
  constructor(_context: unknown, shell: ShellPort, windows: WindowServiceTransport) { fixture.shell = shell; fixture.windows = windows }
  initialize = fixture.initialize
  beginQuit = fixture.quit
  dispose = fixture.dispose
  publishProjection(): void {}
} }))
vi.mock('../../lib-orchestrator/perfMonitor/perfMonitor', () => ({ PerfMonitor: class { start() {}; event() {}; async stop() {} } }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), writeSync: (_fd: number, bytes: string) => { fixture.output.push(bytes); return bytes.length } }))

class Port extends EventEmitter {
  readonly sent: ProcessMessage[] = []
  postMessage(message: ProcessMessage): void { this.sent.push(message) }
  start(): void {}
  close(): void { this.emit('close') }
  receive(data: ProcessMessage, ports?: ProcessPort[]): void { this.emit('message', { data, ports }) }
}
const build = { version: 'test', inputHash: 'test', builtAt: 'test' }
const initialize = { type: 'initialize' as const, identity: { configIdentity: 'u26-fixture', channel: 'development' as const, stateDirectory: 'fixture' },
  bootstrap: { config: { configDir: 'fixture', identity: { configIdentity: 'u26-fixture' }, runtimeChannel: 'development' as const },
    smoke: true, appVersion: 'test', privateStateRoot: true, applicationRoot: '.', resourcesPath: '.', isPackaged: false,
    shell: { groups: [], panels: [], lastFocusedWindowId: null } } }
const tick = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('orchestrator process boundary', () => {
  const apps: OrchestratorApp[] = []
  beforeEach(() => { vi.clearAllMocks(); fixture.output.length = 0; fixture.initialize.mockImplementation(async () => {}); fixture.dispose.mockImplementation(async () => true) })
  afterEach(async () => { for (const app of apps.splice(0)) await app.stop(0); vi.useRealTimers() })
  function start() {
    const parent = new Port(), gateway = new Port(), exit = vi.fn()
    const app = new OrchestratorApp(parent, build, 'bundles', exit)
    apps.push(app); app.start(); parent.receive(initialize, [gateway])
    return { app, parent, gateway, exit }
  }

  it('serves requests and native callbacks while asynchronous initialization is pending', async () => {
    let release!: () => void
    fixture.initialize.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const { parent } = start()
    expect(parent.sent[0]).toEqual({ type: 'hello', process: 'orchestrator', build })
    expect(parent.sent).not.toContainEqual({ type: 'ready' })
    const sealed = fixture.shell!.cipher.encrypt('secret')
    const request = parent.sent.find(message => message.type === 'call')!
    expect(request).toMatchObject({ type: 'call', target: 'shell', method: 'cipher.encrypt', args: ['secret'] })
    if (request.type !== 'call') throw new Error('Missing callback request')
    parent.receive({ type: 'reply', id: request.id, ok: true, value: new Uint8Array([7]) })
    await expect(sealed).resolves.toEqual(new Uint8Array([7]))
    parent.receive({ type: 'call', id: 50, target: 'orchestrator', method: 'mediaOpen', args: [{ requestId: 'media' }] })
    await tick()
    expect(parent.sent).toContainEqual({ type: 'pending', id: 50 })
    expect(parent.sent).toContainEqual({ type: 'reply', id: 50, ok: true, value: { accepted: true } })
    release(); await tick()
    expect(parent.sent).toContainEqual({ type: 'ready' })
  })

  it('bounds caller ownership through repeated reloads and delivers one final close for the latest epoch', async () => {
    const { app, parent } = start()
    const gone: unknown[] = []
    fixture.windows!.onCaller('gone', (caller, reason) => gone.push([caller.id, reason]))
    for (let i = 0; i < 100; i++) {
      const caller = { id: 'epoch-' + i, windowId: 'workspace', role: 'workspace' as const }
      parent.receive({ type: 'window-port', windowId: '42', epoch: caller.id, caller, accepting: true }, [new Port()])
      parent.receive({ type: 'window-close', windowId: '42', epoch: caller.id, reason: 'reload' })
      expect((app as unknown as { callers: Map<string, unknown> }).callers.size).toBe(1)
    }
    parent.receive({ type: 'window-close', windowId: '42', epoch: 'epoch-0', reason: 'closed' })
    expect(gone).toHaveLength(100)
    parent.receive({ type: 'window-close', windowId: '42', epoch: 'epoch-99', reason: 'closed' })
    parent.receive({ type: 'window-close', windowId: '42', epoch: 'epoch-99', reason: 'closed' })
    expect(gone).toHaveLength(101)
    expect(gone.at(-1)).toEqual(['epoch-99', 'closed'])
    expect((app as unknown as { callers: Map<string, unknown> }).callers.size).toBe(0)
  })

  it.each([3000, 20000])('writes entry before the %s ms utility block and exit afterward with the utility PID', async milliseconds => {
    const { parent } = start()
    const phases: string[] = []
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, duration) => {
      expect(duration).toBe(milliseconds)
      phases.push(...fixture.output.map(line => JSON.parse(line.slice('[latency-smoke] '.length)).phase))
      return 'timed-out'
    })
    try {
      parent.receive({ type: 'call', id: 1, target: 'debug', method: 'block', args: [{ target: 'orchestrator', id: 'test', milliseconds }] })
      await tick()
      expect(phases).toEqual(['start'])
      const records = fixture.output.map(line => JSON.parse(line.slice('[latency-smoke] '.length)))
      expect(records.map(record => record.phase)).toEqual(['start', 'end'])
      for (const record of records) {
        expect(record).toMatchObject({ id: 'test', target: 'orchestrator', process: 'orchestrator', pid: process.pid, milliseconds })
        expect(record.at).toBeGreaterThan(0)
      }
    } finally { wait.mockRestore() }
  })

  it('joins pending initialization before disposing owners and acknowledging stopped', async () => {
    let release!: () => void
    fixture.initialize.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const { app, parent, exit } = start()
    const stopped = app.stop(0)
    await tick()
    expect(fixture.quit).toHaveBeenCalled()
    expect(fixture.dispose).not.toHaveBeenCalled()
    expect(parent.sent.some(message => message.type === 'stopped')).toBe(false)
    release()
    await stopped
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(parent.sent.some(message => message.type === 'ready')).toBe(false)
    expect(parent.sent.at(-1)).toEqual({ type: 'stopped', process: 'orchestrator', recordsSettled: true })
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it.each([true, false])('acknowledges only the completed records result, settled=%s', async recordsSettled => {
    let release!: () => void
    let entered!: () => void
    const disposeEntered = new Promise<void>(resolve => { entered = resolve })
    fixture.dispose.mockImplementation(() => new Promise<boolean>(resolve => { release = () => resolve(recordsSettled); entered() }))
    const { app, parent, exit } = start()
    const stopped = app.stop(0)
    await disposeEntered
    try {
      expect(parent.sent.some(message => message.type === 'stopped')).toBe(false)
      expect(exit).not.toHaveBeenCalled()
    } finally { release() }
    await stopped
    const receipt = { type: 'stopped', process: 'orchestrator', recordsSettled }
    expect(parent.sent.at(-1)).toEqual(receipt)
    expect(fixture.output).toContain('[client-drain] ' + JSON.stringify(receipt) + '\n')
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('cancels an accepted media pull through the same live request channel', async () => {
    let finish!: () => void
    fixture.mediaOpen.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ accepted: true }) }))
    const { parent } = start()
    parent.receive({ type: 'call', id: 20, target: 'orchestrator', method: 'mediaOpen', args: [{ requestId: 'bounded-pull' }] })
    parent.receive({ type: 'cancel', id: 20 })
    expect(fixture.mediaCancel).toHaveBeenCalledExactlyOnceWith('bounded-pull')
    finish(); await tick()
    expect(parent.sent.some(message => message.type === 'reply' && message.id === 20)).toBe(false)
  })
})
