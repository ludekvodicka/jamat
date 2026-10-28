import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { TerminalInstance } from '../../app-host/app/terminal/terminalInstance.js'
import { TerminalDescendants, type TerminalDescendant } from '../../app-host/app/terminal/terminalDescendants.js'
import { SessionManager } from '../../app-host/app/sessions/sessionManager.js'
import { SessionStore } from '../../app-host/app/sessions/sessionStore.js'
import { EventHub } from '../../app-host/app/events/eventHub.js'

async function run(): Promise<void> {
  if (process.platform !== 'win32') { console.log('[managed-run-stop] Windows process-tree scenario skipped'); return }
  const args = process.argv.slice(2)
  assert(args.length === 2 && args[0] === '--test-root', 'Usage: managedRunStop.ts --test-root <directory>')
  const parent = await realpath(resolve(args[1]))
  const root = await mkdtemp(join(parent, 'managed-stop-'))
  const source = join(root, 'parent.cjs')
  await writeFile(source, `const { spawn } = require('node:child_process');
const worker = "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)";
const children = Array.from({ length: 3 }, () => spawn(process.execPath, ['-e', worker], { detached: true, stdio: 'ignore', windowsHide: true }));
console.log('OWNED:' + children.map((child) => child.pid).join(','));
setInterval(() => {}, 1000);
`)
  for (const failure of ['none', 'capture', 'kill'] as const) {
  let output = ''
  const capture = TerminalDescendants.capture, stop = TerminalDescendants.stop
  const terminal = new TerminalInstance('managed-stop-fixture', 1, 1, {
    command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/q', '/c', `cd /d ${root} || exit /b & node ${source} || exit /b`], cwd: root,
    env: Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])),
    cols: 100, rows: 30, stopDescendants: true,
  }, (event) => { if (event.type === 'data') output += event.delta })
  let owned: TerminalDescendant[] = []
  try {
    await terminal.ready()
    const deadline = Date.now() + 10_000
    while (!/OWNED:(\d+),(\d+),(\d+)/.test(output) && Date.now() < deadline) await setTimeout(25)
    const match = output.match(/OWNED:(\d+),(\d+),(\d+)/)
    assert(match, output)
    const children = match.slice(1).map(Number)
    owned = await TerminalDescendants.capture(terminal.pid, terminal.processStartedAt)
    assert(children.every((pid) => owned.some((child) => child.pid === pid)), 'The three detached workers must belong to the managed run')
    const started = Date.now()
    if (failure === 'capture') {
      TerminalDescendants.capture = async () => { throw new Error('Fixture inspection refusal') }
      await assert.rejects(terminal.stop(), /inspection failed/)
      TerminalDescendants.capture = capture
      assert.equal(terminal.alive, true, 'Capture refusal must leave the parent available for a complete retry')
      console.log('[managed-run-stop] Inspection refusal preserves the live root for retry')
    }
    else if (failure === 'kill') {
      TerminalDescendants.stop = async () => { throw new Error('Fixture kill refusal') }
      await assert.rejects(terminal.stop(), /kill refusal/)
      assert.equal(terminal.alive, false)
      await assert.rejects(terminal.stop(), /kill refusal/)
      TerminalDescendants.stop = stop
    }
    else if (failure !== 'none') throw new Error(`Unexpected fixture: ${failure satisfies never}`)
    await terminal.stop()
    const elapsed = Date.now() - started
    assert(elapsed < 15_000, `Stop exceeded the client timeout: ${elapsed} ms`)
    assert.equal(terminal.alive, false)
    for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    console.log(`[managed-run-stop] Root and three detached managed children exited in ${elapsed} ms; fixture ${root}`)
  } finally {
    TerminalDescendants.capture = capture
    TerminalDescendants.stop = stop
    await TerminalDescendants.stop(owned)
    if (terminal.alive) await terminal.stop()
    terminal.dispose()
  }
  }
  const events = new EventHub()
  const host = new SessionManager(new SessionStore(join(root, 'host-state.json'), () => {}), events, 'stop-fixture')
  const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  const stop = TerminalDescendants.stop
  let owned: TerminalDescendant[] = []
  try {
    const managed = await host.create({ controllerLeaseId: 'fixture', operationId: 'managed', runtimeSessionId: 'managed',
      launch: { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/q', '/c', `node ${source}`], cwd: root, env, cols: 100, rows: 30, stopDescendants: true } })
    await setTimeout(500)
    owned = await TerminalDescendants.capture(managed.pid!, managed.processStartedAt!)
    assert(owned.length >= 4)
    await host.create({ controllerLeaseId: 'fixture', operationId: 'interactive', runtimeSessionId: 'interactive',
      launch: { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/q', '/k'], cwd: root, env, cols: 100, rows: 30, stopDescendants: false } })
    TerminalDescendants.stop = async (children) => { if (children.length > 0) throw new Error('Fixture owned descendant refusal') }
    await assert.rejects(host.stop({ hostInstanceId: 'stop-fixture', runtimeSessionId: 'managed', generation: 1 }), /owned descendant refusal/)
    const warnings = await host.stopAll()
    assert(warnings.some((line) => line.includes('owned descendant refusal')))
    assert.equal(host.liveCount(), 0)
    await assert.rejects(host.create({ controllerLeaseId: 'fixture', operationId: 'late', runtimeSessionId: 'late',
      launch: { command: 'cmd.exe', args: [], cwd: root, env, cols: 80, rows: 24, stopDescendants: false } }), /Host is stopping/)
    console.log('[managed-run-stop] Real Host shutdown drains live terminals and reports a refused dead runtime without aborting shutdown')
  } finally {
    TerminalDescendants.stop = stop
    await TerminalDescendants.stop(owned)
    await host.stopAll()
    host.destroy()
  }
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
