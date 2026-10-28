import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { UsageUiScenario } from './usageUiScenario.js'

test('Usage fixture finds subclass windows through BaseWindow and acknowledges each menu command after initialization', () => {
  const windows: NativeWindow[] = []
  let tick: () => void = () => {}, itemClicks = 0, nextWindowId = 0, result: any = null
  let command = { id: 1, action: 'open' }
  class NativeWindow {
    readonly id: number
    readonly options: Record<string, unknown>
    fixtureTitle?: string
    title = ''
    loaded = false
    readonly webContents = { isLoadingMainFrame: () => !this.loaded, getURL: () => this.loaded ? 'file:///usage.html' : '' }
    constructor(options: Record<string, unknown>) { this.options = options; this.id = ++nextWindowId; windows.push(this) }
    static getAllWindows() { return windows.filter(window => window.constructor === NativeWindow) }
    getTitle() { return this.title }
    close() { windows.splice(windows.indexOf(this), 1) }
  }
  const module = { _load: (_name: string): unknown => undefined }
  const menu = { items: [{ label: 'Tools', submenu: { items: [{ label: 'Usage', click: () => {
    itemClicks++
    const usage = windows.find(window => window.fixtureTitle === 'Jamat Usage')
    if (!usage) new (module._load('electron') as any).BrowserWindow({ title: 'Jamat Usage' })
    else (usage as any).focus()
  } }] } }] }
  const electron = { BrowserWindow: NativeWindow, BaseWindow: { getAllWindows: () => windows }, Notification: class { show() {} },
    app: { setAppPath: () => {} }, Menu: { getApplicationMenu: () => menu } }
  const fs = { readFileSync: () => JSON.stringify(command), writeFileSync: (_file: string, body: string) => { result = JSON.parse(body) } }
  runInNewContext(UsageUiScenario.fixtureSource('repo'), { __dirname: 'fixture', console,
    require: (name: string) => ({ electron, 'node:module': module, 'node:fs': fs, 'node:path': { join },
      'node:child_process': { spawn() { throw new Error('No child expected') } } }[name]),
    setInterval: (callback: () => void) => { tick = callback; return { unref() {} } },
  })
  const workspace = new NativeWindow({ title: 'Jamat V3' })
  tick()
  assert.equal(result, null)
  assert.equal(electron.BaseWindow.getAllWindows().length, 2)
  assert.deepEqual(NativeWindow.getAllWindows(), [workspace])
  assert.deepEqual(JSON.parse(JSON.stringify(windows[1].options)), { title: 'Jamat Usage', show: false, focusable: false,
    webPreferences: { backgroundThrottling: false, offscreen: true } })
  tick()
  assert.equal(itemClicks, 1)
  windows[1].loaded = true
  windows[1].title = 'Jamat Usage'
  tick()
  assert.deepEqual(result, { id: 1, windows: [{ id: 2, focuses: 0 }] })
  command = { id: 2, action: 'open' }
  tick()
  assert.deepEqual(result, { id: 2, windows: [{ id: 2, focuses: 1 }] })
  assert.equal(itemClicks, 2)
  command = { id: 3, action: 'close' }
  tick()
  assert.deepEqual(result, { id: 3, windows: [] })
  assert.deepEqual(windows, [workspace])
  command = { id: 4, action: 'open' }
  tick()
  assert.deepEqual(result, { id: 3, windows: [] })
  windows[1].loaded = true
  tick()
  assert.deepEqual(result, { id: 4, windows: [{ id: 3, focuses: 0 }] })
  assert.equal(itemClicks, 3)
})

test('Usage fixture records only its detached private Host at spawn time before any descriptor exists', () => {
  const receipts: { file: string; pids: number[] }[] = []
  const children = { spawn: (_command: string, _args: string[], _options: object) => ({ pid: 123 }) }
  const electron = { BrowserWindow: class {}, Notification: class {}, app: { setAppPath: () => {} } }
  runInNewContext(UsageUiScenario.fixtureSource('repo'), { __dirname: 'fixture', console,
    require: (name: string) => ({ electron, 'node:module': { _load() {} }, 'node:path': { join }, 'node:child_process': children,
      'node:fs': { writeFileSync: (file: string, body: string) => receipts.push({ file, pids: JSON.parse(body) }) } }[name]),
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
