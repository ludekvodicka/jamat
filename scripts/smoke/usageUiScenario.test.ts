import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { UsageUiScenario } from './usageUiScenario.js'

test('Usage fixture clicks Tools > Usage once per command after the menu exists and reports the window count', () => {
  const windows: NativeWindow[] = []
  let tick: () => void = () => {}, itemClicks = 0, result: any = null, menu: unknown = null
  let command = { id: 1 }
  class NativeWindow {
    readonly options: Record<string, unknown>
    constructor(options: Record<string, unknown>) { this.options = options; windows.push(this) }
  }
  const module = { _load: (_name: string): unknown => undefined }
  const electron = { utilityProcess: { fork() {} }, BrowserWindow: NativeWindow, BaseWindow: { getAllWindows: () => windows }, Notification: class { show() {} },
    app: { setAppPath: () => {} }, Menu: { getApplicationMenu: () => menu } }
  const fs = { readFileSync: () => JSON.stringify(command), writeFileSync: (_file: string, body: string) => { result = JSON.parse(body) } }
  runInNewContext(UsageUiScenario.fixtureSource('repo'), { __dirname: 'fixture', console,
    require: (name: string) => ({ electron, 'node:module': module, 'node:fs': fs, 'node:path': { join },
      'node:child_process': { spawn() { throw new Error('No child expected') } } }[name]),
    setInterval: (callback: () => void) => { tick = callback; return { unref() {} } },
  })
  new (module._load('electron') as any).BrowserWindow({ title: 'Jamat V3' })
  assert.deepEqual(JSON.parse(JSON.stringify(windows[0].options)), { title: 'Jamat V3', show: false, focusable: false,
    webPreferences: { backgroundThrottling: false, offscreen: true } })
  tick()
  assert.equal(result, null)
  menu = { items: [{ label: 'Tools', submenu: { items: [{ label: 'Usage', click: () => { itemClicks++ } }] } }] }
  tick()
  tick()
  assert.deepEqual(result, { id: 1, windows: 1 })
  assert.equal(itemClicks, 1)
  command = { id: 2 }
  tick()
  assert.deepEqual(result, { id: 2, windows: 1 })
  assert.equal(itemClicks, 2)
})

test('Usage fixture records only its detached private Host at spawn time before any descriptor exists', () => {
  const receipts: { file: string; pids: number[] }[] = []
  const children = { spawnSync: () => ({ status: 0, stdout: '1000' }), spawn: (_command: string, _args: string[], _options: object) => ({ pid: 123 }) }
  const electron = { BrowserWindow: class {}, Notification: class {}, app: { setAppPath: () => {} } }
  runInNewContext(UsageUiScenario.hostFixtureSource('bundle', 'fixture'), { __dirname: 'fixture', console, process: { pid: 55 },
    require: (name: string) => ({ electron, 'node:module': { _load() {} }, 'node:path': { join }, 'node:child_process': children,
      'node:fs': { existsSync: () => false, writeFileSync: (file: string, body: string) => {
        if (file === join('fixture', 'host-pids.json')) receipts.push({ file, pids: JSON.parse(body) })
        else assert.deepEqual(JSON.parse(body), { pid: 55, startedAt: 1000 })
      } } }[name]),
    setInterval: () => ({ unref() {} }),
  })
  const args = ['--config-dir', join('fixture', 'config')]
  children.spawn('node', args, { detached: true, env: { JAMAT_V3_HOST_STATE_DIR: 'foreign' } })
  children.spawn('node', args, { detached: false, env: { JAMAT_V3_HOST_STATE_DIR: join('fixture', 'state/host') } })
  children.spawn('node', ['--config-dir', 'foreign'], { detached: true, env: { JAMAT_V3_HOST_STATE_DIR: join('fixture', 'state/host') } })
  assert.deepEqual(receipts, [])
  children.spawn('node', args, { detached: true, env: { JAMAT_V3_HOST_STATE_DIR: join('fixture', 'state/host') } })
  assert.deepEqual(receipts, [{ file: join('fixture', 'host-pids.json'), pids: [123] }])
})

test('Usage fixture wraps only the orchestration utility and preserves its fork arguments', () => {
  const forks: unknown[][] = [], written: [string, string][] = []
  const module = { _load(_name?: string): unknown { return undefined } }
  const electron = { utilityProcess: { fork: (...args: unknown[]) => { forks.push(args); return 'child' } },
    BrowserWindow: class {}, Notification: class {}, app: { setAppPath() {} } }
  runInNewContext(UsageUiScenario.fixtureSource('repo'), { __dirname: 'fixture', console,
    require: (name: string) => ({ electron, 'node:module': module, 'node:path': { join },
      'node:fs': { writeFileSync: (file: string, body: string) => written.push([file, body]) } }[name]),
    setInterval: () => ({ unref() {} }),
  })
  const isolated = module._load('electron') as any
  assert.equal(isolated.utilityProcess.fork('gateway', [], { serviceName: 'Jamat gateway' }), 'child')
  assert.equal(written.length, 0)
  assert.equal(isolated.utilityProcess.fork('orchestrator', ['argument'], { serviceName: 'Jamat orchestrator', stdio: 'pipe' }), 'child')
  assert.deepEqual(written[0], [join('fixture', 'utility-intent'), ''])
  assert.equal(written[1][0], join('fixture', 'orchestrator-fixture.cjs'))
  assert.equal(written[1][1], UsageUiScenario.hostFixtureSource('orchestrator', 'fixture'))
  assert.equal(JSON.stringify(forks), JSON.stringify([
    ['gateway', [], { serviceName: 'Jamat gateway' }],
    [join('fixture', 'orchestrator-fixture.cjs'), ['argument'], { serviceName: 'Jamat orchestrator', stdio: 'pipe' }],
  ]))
})

test('a late utility publishes its birth then exits before loading the app when cleanup has begun', () => {
  const order: unknown[] = [], exited = new Error('fixture exit')
  assert.throws(() => runInNewContext(UsageUiScenario.hostFixtureSource('real-bundle', 'fixture'), {
    process: { pid: 77, exit: (code: number) => { order.push(['exit', code]); throw exited } },
    require: (name: string) => {
      if (name === 'node:child_process') return { spawnSync: () => ({ status: 0, stdout: '1000' }), spawn() { throw new Error('No Host may start') } }
      if (name === 'node:path') return { join }
      if (name === 'node:fs') return { existsSync: () => true, writeFileSync: (path: string, value: string) => order.push([path, JSON.parse(value)]) }
      throw new Error('App must not load: ' + name)
    },
  }), error => error === exited)
  assert.deepEqual(order, [[join('fixture', 'utility-birth.json'), { pid: 77, startedAt: 1000 }], ['exit', 0]])
})
