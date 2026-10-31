import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { AppConfig } from './appConfig'
import { AppContext } from './appContext'
import { AppHub } from './appHub'
import { LauncherTarget } from './launcherTarget'
import { LocalTargetControl } from './localTargetControl'

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  return address.port
}

async function fixture(t: TestContext, exitCode = 0, batch = false, source = false, detached = false, development = false) {
  const root = mkdtempSync(join(tmpdir(), 'jamat-launcher-test-'))
  const environment = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME }
  process.env.LOCALAPPDATA = root
  process.env.XDG_STATE_HOME = root
  const identity = { schemaVersion: 1, configIdentity: randomUUID(), runtimeChannel: 'development', createdAt: new Date().toISOString() }
  const profile = join(root, 'profile')
  mkdirSync(profile)
  writeFileSync(join(profile, 'config-identity.json'), JSON.stringify(identity))
  const marker = join(root, 'launched.txt')
  const instance = { ...identity, instanceId: randomUUID(), startedAt: Date.now(), applicationVersion: '3.5.0' }
  const token = randomBytes(32).toString('hex')
  const control = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || !existsSync(marker)) {
      res.writeHead(503).end()
      return
    }
    let text = ''
    req.on('data', chunk => { text += String(chunk) })
    req.on('end', () => {
      const request = JSON.parse(text)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ protocol: RemoteControlConst.protocol, requestId: request.requestId,
        operation: request.operation, operationId: null, ok: true,
        value: { ...instance, protocol: RemoteControlConst.protocol, operations: RemoteControlConst.descriptorOperations },
      }))
    })
  })
  const controlPort = await listen(control)
  const directory = join(root, 'jamat-v3', 'client-ui', identity.configIdentity, identity.runtimeChannel)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'remote-control.json'), JSON.stringify({
    schemaVersion: 1, protocol: RemoteControlConst.protocol,
    configIdentity: identity.configIdentity, runtimeChannel: identity.runtimeChannel,
    instanceId: instance.instanceId, startedAt: instance.startedAt, applicationVersion: instance.applicationVersion,
    address: '127.0.0.1', port: controlPort, pid: process.pid, token,
    operations: RemoteControlConst.descriptorOperations, websocket: true,
  }))
  const script = join(root, 'launch.cjs')
  writeFileSync(script, `${exitCode === 0 ? `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'start\\n');` : ''} process.exit(${exitCode})`)
  const key = randomBytes(32).toString('hex')
  const batchFile = join(root, 'launch with spaces.bat')
  writeFileSync(batchFile, `@echo off\r\n"${process.execPath}" "${script}"\r\nexit /b %errorlevel%\r\n`)
  const input = { publicUrl: 'http://127.0.0.1:3511', key, configDir: profile,
    configIdentity: identity.configIdentity, runtimeChannel: identity.runtimeChannel,
    logFile: join(root, 'log.txt'), recipe: { kind: detached ? 'detached-command' : 'command',
      command: batch ? join(process.env.SystemRoot!, 'System32', 'cmd.exe') : process.execPath,
      args: batch ? ['/d', '/s', '/c', `""${batchFile}""`] : [script], cwd: root, windowsVerbatimArguments: batch } }
  const checkout = join(root, 'source checkout with spaces')
  if (source) {
    mkdirSync(join(checkout, 'node_modules'), { recursive: true })
    symlinkSync(realpathSync('node_modules/tsx'), join(checkout, 'node_modules/tsx'), 'junction')
    mkdirSync(join(checkout, 'scripts/release'), { recursive: true })
    writeFileSync(join(checkout, 'scripts/release/start-packaged-client.ts'), `
      require('node:fs').writeFileSync(${JSON.stringify(join(root, 'source-env.json'))}, JSON.stringify({
        configDir: process.env.JAMAT_V3_CONFIG_DIR, channel: process.env.JAMAT_V3_RUNTIME_CHANNEL,
        executable: process.execPath, cwd: process.cwd()
      })); ${readFileSync(script, 'utf8')}`)
  }
  if (development)
    for (const path of ['app-client-ui/node_modules/electron-vite/bin/electron-vite.js',
      'app-client-ui/package.json', 'app-client-ui/electron.vite.config.ts', 'app-host/start.ts']) {
      mkdirSync(join(checkout, path, '..'), { recursive: true })
      writeFileSync(join(checkout, path), path.endsWith('package.json') ? '{}' : '')
    }
  const config = new AppConfig(JSON.stringify({ ...input,
    ...(source || development ? { recipe: { kind: development ? 'development' : 'source', repositoryRoot: checkout } } : {}) }))
  const hub = new AppHub(config, new AppContext(config.logFile))
  const port = await listen(hub.listener.server)
  config.publicUrl.port = String(port)
  t.after(async () => {
    const pidFile = join(root, 'child-pid.txt')
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8'))) } catch { /* The child may have ended already. */ }
      for (let tries = 0; tries < 100; tries++) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0) } catch { break }
        await setTimeout(20)
      }
    }
    await Promise.all([control, hub.listener.server].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    for (const [name, value] of Object.entries(environment))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const headers = (method: string, path: string, timestamp = String(Date.now())) => {
    const nonce = randomBytes(16).toString('hex')
    return { 'x-jamat-timestamp': timestamp, 'x-jamat-nonce': nonce,
      'x-jamat-signature': createHmac('sha256', Buffer.from(key, 'hex')).update(`${method}\n${path}\n${timestamp}\n${nonce}`).digest('hex') }
  }
  const request = (method: string, path: string) => fetch(`${config.publicUrl.origin}${path}`, { method, headers: headers(method, path) })
  return { root, checkout, marker, input, config, headers, request }
}

test('auth rejects absent, stale, replayed and cross-origin requests and caller-supplied commands', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(`${f.config.publicUrl.origin}/api/start`, { method: 'POST' })).status, 401)
  const headers = f.headers('GET', '/api/status')
  assert.equal((await fetch(`${f.config.publicUrl.origin}/api/status`, { headers })).status, 200)
  assert.equal((await fetch(`${f.config.publicUrl.origin}/api/status`, { headers })).status, 401)
  assert.equal((await fetch(`${f.config.publicUrl.origin}/api/status`, { headers: f.headers('GET', '/api/status', String(Date.now() - 31_000)) })).status, 401)
  assert.equal((await fetch(`${f.config.publicUrl.origin}/api/start`, { method: 'POST', headers: { ...f.headers('POST', '/api/start'), Origin: f.config.publicUrl.origin } })).status, 403)
  assert.equal((await fetch(`${f.config.publicUrl.origin}/api/start`, { method: 'POST', headers: f.headers('POST', '/api/start'), body: '{"command":"anything"}' })).status, 400)
  assert.equal((await f.request('POST', '/api/start?profile=other')).status, 404)
  assert.equal(existsSync(f.marker), false)
})

for (const development of [false, true])
test(`${development ? 'development checkout' : 'detached command'} reaches ready before exit with the exact environment and cwd`, async t => {
  const f = await fixture(t, 0, false, false, true, development)
  const pid = join(f.root, 'child-pid.txt')
  const envFile = join(f.root, 'child-env.json')
  const script = development ? join(f.checkout, 'app-client-ui/node_modules/electron-vite/bin/electron-vite.js') : join(f.root, 'launch.cjs')
  writeFileSync(script, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({cwd:process.cwd(), profile:process.env.JAMAT_V3_CONFIG_DIR, channel:process.env.JAMAT_V3_RUNTIME_CHANNEL, args:process.argv.slice(2)}));
    fs.appendFileSync(${JSON.stringify(f.marker)}, 'start\\n');
    setInterval(() => {}, 1000);
  `)
  const starts = await Promise.all(Array.from({ length: 5 }, () => f.request('POST', '/api/start')))
  assert.ok(starts.every(value => value.status === 202 || value.status === 200))
  for (let i = 0; i < 100; i++) {
    if ((await (await f.request('GET', '/api/status')).json() as { state: string }).state === 'ready') break
    await setTimeout(25)
  }
  assert.deepEqual(await (await f.request('GET', '/api/status')).json(), { state: 'ready' })
  process.kill(Number(readFileSync(pid, 'utf8')), 0)
  assert.equal(readFileSync(f.marker, 'utf8'), 'start\n')
  assert.deepEqual(JSON.parse(readFileSync(envFile, 'utf8')), { cwd: development ? join(f.checkout, 'app-client-ui') : f.root,
    profile: f.input.configDir, channel: 'development', args: development ? ['dev'] : [] })
})

test('missing target is reported before any start, in the existing state/error envelope', async t => {
  const source = await fixture(t, 0, false, true)
  rmSync(join(source.checkout, 'scripts/release/start-packaged-client.ts'))
  assert.deepEqual(await (await source.request('GET', '/api/status')).json(), { state: 'failed', error: 'target-missing' })
  assert.equal((await source.request('POST', '/api/start')).status, 202)
  await setTimeout(25)
  assert.deepEqual(await (await source.request('GET', '/api/status')).json(), { state: 'failed', error: 'target-missing' })
  assert.equal(existsSync(source.marker), false)
})

test('readiness timeout keeps the owned detached process and refuses a duplicate attempt', async t => {
  const f = await fixture(t)
  const pid = join(f.root, 'child-pid.txt')
  writeFileSync(join(f.root, 'launch.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid)); setInterval(() => {}, 1000)`)
  const target = new LauncherTarget({ command: process.execPath, args: [join(f.root, 'launch.cjs')], cwd: f.root,
    windowsVerbatimArguments: false, completion: 'spawn', requireRunning: true, requiredFiles: [], readinessTimeoutMs: 100 },
  f.config.configDir, 'development', new LocalTargetControl(f.config.configDir, f.config.identity), new AppContext(f.config.logFile))
  assert.deepEqual(await target.start(), { state: 'starting' })
  for (let i = 0; i < 100; i++) {
    if ((await target.status()).state === 'failed') break
    await setTimeout(25)
  }
  assert.deepEqual(await target.status(), { state: 'failed', error: 'readiness-timeout' })
  process.kill(Number(readFileSync(pid, 'utf8')), 0)
  await assert.rejects(target.start(), /previous launch process is still running/)
})

test('a detached command that exits before readiness reports a launch failure', async t => {
  const f = await fixture(t, 7, false, false, true)
  assert.equal((await f.request('POST', '/api/start')).status, 202)
  for (let i = 0; i < 100; i++) {
    const status = await (await f.request('GET', '/api/status')).json() as { state: string; error?: string }
    if (status.state === 'failed') { assert.equal(status.error, 'launch-failed'); return }
    await setTimeout(25)
  }
  assert.fail('The exited process was not reported')
})

test('simultaneous starts launch exactly once, verify the real control API, then reuse the instance', async t => {
  const f = await fixture(t)
  assert.deepEqual(await (await f.request('GET', '/api/status')).json(), { state: 'stopped' })
  const starts = await Promise.all(Array.from({ length: 8 }, () => f.request('POST', '/api/start')))
  assert.ok(starts.every(response => response.status === 200 || response.status === 202))
  let state = ''
  for (let count = 0; count < 50; count++) {
    state = (await (await f.request('GET', '/api/status')).json() as { state: string }).state
    if (state === 'ready') break
    await setTimeout(50)
  }
  assert.equal(state, 'ready', readFileSync(f.input.logFile, 'utf8'))
  assert.equal((await f.request('POST', '/api/start')).status, 200)
  assert.equal(readFileSync(f.marker, 'utf8'), 'start\n')
})

test('a wrong stored profile is refused instead of creating another identity', async t => {
  const f = await fixture(t)
  assert.throws(() => new AppConfig(JSON.stringify({ ...f.input, configIdentity: randomUUID() })), /identity\/channel/)
  assert.throws(() => new AppConfig(JSON.stringify({ ...f.input, runtimeChannel: 'production' })), /identity\/channel/)
  const stored = JSON.parse(readFileSync(join(f.input.configDir, 'config-identity.json'), 'utf8'))
  assert.equal(stored.configIdentity, f.input.configIdentity)
})

test('a failed launch reports failure without claiming readiness or exposing command details', async t => {
  const f = await fixture(t, 7)
  assert.equal((await f.request('POST', '/api/start')).status, 202)
  let result: { state: string; error?: string } = { state: '' }
  for (let count = 0; count < 50; count++) {
    result = await (await f.request('GET', '/api/status')).json() as typeof result
    if (result.state === 'failed') break
    await setTimeout(50)
  }
  assert.equal(result.state, 'failed')
  assert.equal(JSON.stringify(result).includes(f.root), false)
  assert.equal(existsSync(f.marker), false)
})

test('Windows batch recipe preserves cmd quoting for paths with spaces', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 0, true)
  assert.equal((await f.request('POST', '/api/start')).status, 202)
  let state = ''
  for (let count = 0; count < 50; count++) {
    state = (await (await f.request('GET', '/api/status')).json() as { state: string }).state
    if (state === 'ready') break
    await setTimeout(50)
  }
  assert.equal(state, 'ready')
  assert.equal(readFileSync(f.marker, 'utf8'), 'start\n')
})

test('authenticated maintenance prevents startup until rollback resumes the listener', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'launch.cjs'), `setTimeout(() => {
    require('node:fs').appendFileSync(${JSON.stringify(f.marker)}, 'start\\n'); process.exit(0)
  }, 500)`)
  assert.equal((await fetch(`${f.config.publicUrl.origin}/api/pause`, { method: 'POST' })).status, 401)
  assert.equal((await f.request('POST', '/api/pause')).status, 200)
  assert.equal((await f.request('POST', '/api/start')).status, 503)
  assert.equal(existsSync(f.marker), false)
  assert.equal((await f.request('POST', '/api/resume')).status, 200)
  assert.equal((await f.request('POST', '/api/start')).status, 202)
  assert.equal((await f.request('POST', '/api/pause')).status, 409)
  for (let count = 0; count < 50; count++) {
    if ((await f.request('POST', '/api/pause')).status === 200) {
      assert.equal((await (await f.request('GET', '/api/status')).json() as { state: string }).state, 'ready')
      return
    }
    await setTimeout(50)
  }
  assert.fail('The resumed target did not become ready')
})

test('source recipes run checkout tsx with the launcher Node and pinned profile from paths with spaces', async t => {
  const f = await fixture(t, 0, false, true)
  assert.equal((await f.request('POST', '/api/start')).status, 202)
  let state = ''
  for (let count = 0; count < 100; count++) {
    state = (await (await f.request('GET', '/api/status')).json() as { state: string }).state
    if (state === 'ready' || state === 'failed') break
    await setTimeout(50)
  }
  assert.equal(state, 'ready', readFileSync(f.input.logFile, 'utf8'))
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'source-env.json'), 'utf8')), {
    configDir: f.input.configDir, channel: 'development', executable: process.execPath, cwd: f.checkout,
  })
})
