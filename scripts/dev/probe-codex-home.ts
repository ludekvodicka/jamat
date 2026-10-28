import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Socket } from 'node:net'
import { CodexAppServerClient } from '../../lib-orchestrator/rateMonitor/codexAppServerView'
import { CodexProfileConfiguration } from '../../lib-orchestrator/agentAccounts/codex/codexProfileConfiguration'
import { CodexLaunchConfiguration } from '../../lib-orchestrator/agentAccounts/codexProfileView'

const root = resolve(import.meta.dirname, '../..')
const scratch = join(root, '.aidocs/temp/codex-home-probe', randomUUID())
const main = join(scratch, 'main')
const added = join(scratch, 'added')
const cwd = join(scratch, 'workspace')
const binary = process.argv[2]
assert.ok(binary, 'Pass the installed native Codex executable explicitly')
for (const path of [main, added, cwd, join(scratch, 'os-home'), join(scratch, 'temp')])
  mkdirSync(path, { recursive: true })
const denied: string[] = []
const requests: { path: string; account: string | null }[] = []
const outputs: Record<string, unknown> = { scratch }
const children = new Set<ChildProcessWithoutNullStreams>()
const sockets = new Set<Socket>()
interface RpcMessage { id?: number; method?: string; error?: unknown; result?: unknown }
const deny = createServer((request, response) => {
  denied.push(`${request.method} ${request.url}`)
  response.writeHead(403).end('External network denied by disposable probe')
})
deny.on('connect', (request, socket) => {
  denied.push(`CONNECT ${request.url}`)
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
})
const api = createServer((request, response) => {
  const account = request.headers['chatgpt-account-id']
  requests.push({ path: request.url ?? '', account: typeof account === 'string' ? account : null })
  if (request.url?.endsWith('/usage')) {
    const used = account === 'fixture-account-main' ? 12 : account === 'fixture-account-added' ? 34 : null
    if (used === null) {
      response.writeHead(400).end('Expected synthetic account header')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: used, reset_at: 1893456000, reset_after_seconds: 18000, limit_window_seconds: 18000 },
        secondary_window: { used_percent: used + 1, reset_at: 1894060800, reset_after_seconds: 604800, limit_window_seconds: 604800 } },
    }))
    return
  }
  if (!request.url?.endsWith('/responses')) {
    response.writeHead(404).end()
    return
  }
  request.resume()
  request.once('end', () => {
    const message = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'DISPOSABLE_PROBE_REPLY', annotations: [] }] }
    const result = { id: `resp_${requests.length}`, object: 'response', status: 'completed', output: [message],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: 'DISPOSABLE_PROBE_REPLY' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: result },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
})
for (const server of [api, deny]) server.on('connection', socket => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})

async function listen(server: typeof api): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function waitFor(check: () => boolean, milliseconds = 20000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Bounded probe timed out')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(path, entry.name)).map(name => `${entry.name}/${name}`) : [entry.name])
}

function auth(home: string, account: string, expired: boolean): void {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = `${encode({ alg: 'none' })}.${encode({ sub: account, exp: expired ? 1 : 4102444800,
    'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'plus' } })}.fixture`
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    id_token: token, access_token: `synthetic-access-${account}`, refresh_token: `synthetic-refresh-${account}`, account_id: account,
  }, last_refresh: expired ? '2000-01-01T00:00:00Z' : new Date().toISOString() }))
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function command(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(binary!, args, { env, cwd, windowsHide: true, stdio: 'pipe' })
  children.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill(), 20000)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ code, stdout, stderr })
    })
  })
}

async function server(env: NodeJS.ProcessEnv, overrides: string[] = []) {
  const child = spawn(binary!, [...overrides, 'app-server'], { env, cwd, windowsHide: true, stdio: 'pipe' })
  children.add(child)
  const pending = new Map<number, (message: RpcMessage) => void>()
  const notifications: RpcMessage[] = []
  let stderr = ''
  let id = 0
  child.stderr.on('data', data => { stderr += data })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const message = JSON.parse(line) as RpcMessage
    if (typeof message.id === 'number') pending.get(message.id)?.(message)
    else notifications.push(message)
  })
  const call = <T = unknown>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 20000)
    pending.set(requestId, message => {
      clearTimeout(timer)
      pending.delete(requestId)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result as T)
    })
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
  })
  const close = async () => {
    child.stdin.end()
    await waitFor(() => child.exitCode !== null)
    children.delete(child)
    lines.close()
  }
  await call('initialize', { clientInfo: { name: 'jamat_disposable_home_probe', version: '1' } })
  child.stdin.write('{"method":"initialized","params":{}}\n')
  return { call, notifications, close, stderr: () => stderr }
}

async function run(): Promise<void> {
  const apiPort = await listen(api)
  const denyPort = await listen(deny)
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT'])
    if (process.env[name]) env[name] = process.env[name]
  Object.assign(env, { CODEX_HOME: main, CODEX_SQLITE_HOME: main, HOME: join(scratch, 'os-home'),
    USERPROFILE: join(scratch, 'os-home'), APPDATA: join(scratch, 'os-home'), LOCALAPPDATA: join(scratch, 'os-home'),
    TMP: join(scratch, 'temp'), TEMP: join(scratch, 'temp'), TERM: 'xterm-256color',
    HTTP_PROXY: `http://127.0.0.1:${denyPort}`, HTTPS_PROXY: `http://127.0.0.1:${denyPort}`,
    ALL_PROXY: `http://127.0.0.1:${denyPort}`, NO_PROXY: '127.0.0.1,localhost' })
  const config = [
    'model="gpt-6.1-sol"', 'model_provider="local_fixture"', 'check_for_update_on_startup=false',
    'project_root_markers=[".probe-root"]', 'project_doc_max_bytes=0',
    'cli_auth_credentials_store="file"', `chatgpt_base_url="http://127.0.0.1:${apiPort}"`,
    'approval_policy="never"', 'sandbox_mode="read-only"', '[analytics]', 'enabled=false',
    '[feedback]', 'enabled=false', `[projects.${JSON.stringify(cwd)}]`, 'trust_level="trusted"',
    '[model_providers.local_fixture]', 'name="Disposable local fixture"',
    `base_url="http://127.0.0.1:${apiPort}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false',
  ].join('\n')
  writeFileSync(join(main, 'config.toml'), config)
  symlinkSync(join(main, 'config.toml'), join(added, 'config.toml'), 'file')
  writeFileSync(join(cwd, '.probe-root'), '')
  outputs.version = await command(['--version'], env)
  const first = await server(env)
  const started = await first.call<{ thread: { id: string } }>('thread/start', { cwd, model: 'gpt-6.1-sol' })
  const threadId = started.thread.id
  await first.call('turn/start', { threadId, input: [{ type: 'text', text: 'Main disposable conversation', text_elements: [] }] })
  await waitFor(() => first.notifications.some(message => message.method === 'turn/completed'))
  await first.close()
  symlinkSync(join(main, 'sessions'), join(added, 'sessions'), 'junction')
  const secondEnv = { ...env, CODEX_HOME: added }
  const second = await server(secondEnv)
  const resumed = await second.call<{ thread: { id: string } }>('thread/resume', { threadId, cwd })
  assert.equal(resumed.thread.id, threadId)
  await second.close()
  const mainSqlite = files(main).filter(name => /sqlite/.test(name))
  const addedSqlite = files(added).filter(name => /sqlite/.test(name))
  const sqlitePassed = mainSqlite.length > 0 && addedSqlite.length === 0
  outputs.F3 = { mainSqlite, addedSqlite, pass: sqlitePassed }
  outputs.F4 = { threadId, appServerResume: resumed.thread.id, cliResume: 'not-yet-run' }
  assert.equal(sqlitePassed, true, 'F3 failed: SQLite storage is not wholly in main')

  const pty = createRequire(join(root, 'app-host/package.json'))('node-pty')
  const terminal = pty.spawn(binary!, ['--no-daemon', 'resume', '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', threadId],
    { cwd, env: secondEnv as Record<string, string>, cols: 120, rows: 35, name: 'xterm-256color' })
  let terminalOutput = ''
  let terminalEnded = false
  terminal.onExit(() => { terminalEnded = true })
  terminal.onData((data: string) => {
    terminalOutput += data
    if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R')
  })
  try {
    await waitFor(() => terminalOutput.includes('Main disposable conversation'))
    await waitFor(() => terminalOutput.includes('DISPOSABLE_PROBE_REPLY'))
    terminal.write('\x03')
    await new Promise(resolve => setTimeout(resolve, 500))
    terminal.write('\x03')
    await waitFor(() => terminalEnded)
    outputs.F4 = { threadId, appServerResume: resumed.thread.id, cliResume: 'same conversation history loaded', terminalOutput }
  } finally {
    if (!terminalEnded) terminal.kill()
    outputs.terminalOutput = terminalOutput
  }

  auth(added, 'fixture-account-added', true)
  const before = hash(join(added, 'auth.json'))
  const deniedBefore = denied.length
  const requestsBefore = requests.length
  const status = await command(['login', 'status'], secondEnv)
  outputs.loginStatus = { ...status, authUnchanged: before === hash(join(added, 'auth.json')),
    externalAttempts: denied.slice(deniedBefore), localRequests: requests.slice(requestsBefore) }
  auth(main, 'fixture-account-main', false)
  auth(added, 'fixture-account-added', false)
  const quota: unknown[] = []
  for (const [home, account] of [[main, 'fixture-account-main'], [added, 'fixture-account-added']]) {
    const client = new CodexAppServerClient({ environment: { ...env, CODEX_HOME: home }, homeDirectory: cwd,
      onNotification: () => {}, spawnImpl: ((_command: string, args: readonly string[], options: SpawnOptions) => {
        assert.ok(args.includes('app-server'))
        const child = spawn(binary!, ['app-server'], options) as ChildProcessWithoutNullStreams
        children.add(child)
        child.once('exit', () => children.delete(child))
        return child
      }) as typeof spawn })
    try {
      const answer = await client.readRateLimits()
      assert.equal(answer.ok, true)
      assert.equal((answer.result as { rateLimits: { primary: { usedPercent: number } } }).rateLimits.primary.usedPercent,
        account === 'fixture-account-main' ? 12 : 34)
      quota.push({ account, answer })
    } finally { client.stop() }
    await waitFor(() => children.size === 0)
  }
  outputs.F5 = quota
  const override = join(scratch, 'sqlite-config')
  mkdirSync(override)
  writeFileSync(join(added, 'config.toml'), `sqlite_home=${JSON.stringify(override)}\n${config}`)
  const configChild = await server(secondEnv)
  const readConfig = await configChild.call<{ config: Record<string, unknown> }>('config/read', { includeLayers: false, cwd })
  outputs.configRead = { sqliteHome: readConfig.config.sqlite_home, configKeys: Object.keys(readConfig.config) }
  await configChild.call('thread/start', { cwd })
  await configChild.close()
  outputs.sqliteConfigPrecedence = { overrideFiles: files(override).filter(name => /sqlite/.test(name)),
    note: 'An explicit sqlite_home overrides CODEX_SQLITE_HOME; the environment proof assumes it is absent.' }
  const configCases = []
  for (const kind of ['project', 'relative'] as const) {
    const location = join(scratch, `sqlite-${kind}`)
    mkdirSync(location)
    writeFileSync(join(added, 'config.toml'), kind === 'relative' ? `sqlite_home="sqlite-relative"\n${config}` : config)
    if (kind === 'project') {
      mkdirSync(join(cwd, '.codex'))
      writeFileSync(join(cwd, '.codex/config.toml'), `sqlite_home=${JSON.stringify(location)}`)
    }
    const native = await server(secondEnv, ['-c', 'cli_auth_credentials_store="ephemeral"'])
    try {
      const read = await native.call<{ config: Record<string, unknown> }>('config/read', { includeLayers: false, cwd })
      await native.call('thread/start', { cwd })
      configCases.push({ kind, sqliteHome: read.config.sqlite_home, model: read.config.model,
        profile: read.config.profile, overrideFiles: files(location).filter(name => /sqlite/.test(name)),
        relativeCwdFiles: existsSync(join(cwd, 'sqlite-relative')) ? files(join(cwd, 'sqlite-relative')) : [],
        relativeHomeFiles: existsSync(join(added, 'sqlite-relative')) ? files(join(added, 'sqlite-relative')) : [] })
    } finally { await native.close() }
    if (kind === 'project') unlinkSync(join(cwd, '.codex/config.toml'))
  }
  outputs.configCases = configCases
  writeFileSync(join(added, 'config.toml'), config.replace('cli_auth_credentials_store="file"', 'cli_auth_credentials_store="auto"'))
  const inspect = await server(secondEnv, ['-c', 'cli_auth_credentials_store="ephemeral"'])
  const layers = await inspect.call<{ layers: { name: unknown; version: string; config: Record<string, unknown> }[] }>(
    'config/read', { includeLayers: true, cwd })
  outputs.credentialLayers = layers.layers.map(layer => ({ name: layer.name, version: layer.version,
    store: layer.config.cli_auth_credentials_store, keys: Object.keys(layer.config), layerKeys: Object.keys(layer) }))
  await inspect.close()
  const schema = join(scratch, 'schema')
  const generated = await command(['app-server', 'generate-ts', '--out', schema], env)
  assert.equal(generated.code, 0)
  outputs.configSchema = Object.fromEntries(['ConfigReadResponse.ts', 'ConfigLayer.ts', 'ConfigLayerSource.ts', 'ConfigReadParams.ts',
    'ConfigRequirementsReadResponse.ts', 'ConfigRequirements.ts']
    .map(name => [name, readFileSync(join(schema, 'v2', name), 'utf8')]))
  const precedenceCases = []
  for (const trusted of [true, false]) {
    writeFileSync(join(added, 'config.toml'), config.replace('trust_level="trusted"', `trust_level="${trusted ? 'trusted' : 'untrusted'}"`))
    writeFileSync(join(cwd, '.codex/config.toml'), 'cli_auth_credentials_store="ephemeral"')
    const native = await server(secondEnv)
    const result = await native.call<{ config: Record<string, unknown>; layers: Record<string, unknown>[] }>(
      'config/read', { includeLayers: true, cwd })
    precedenceCases.push({ trusted, effectiveStore: result.config.cli_auth_credentials_store,
      layers: result.layers.map(layer => ({ name: layer.name, disabledReason: layer.disabledReason,
        store: (layer.config as Record<string, unknown>).cli_auth_credentials_store })) })
    await native.close()
  }
  outputs.credentialPrecedence = precedenceCases
  unlinkSync(join(cwd, '.codex/config.toml'))
  writeFileSync(join(added, 'config.toml'), config)
  const envRelative = await server({ ...secondEnv, CODEX_SQLITE_HOME: 'relative-env' })
  await envRelative.call('thread/start', { cwd })
  await envRelative.close()
  const relativeEnvFiles = files(join(cwd, 'relative-env')).filter(name => /sqlite/.test(name))
  assert.ok(relativeEnvFiles.length > 0)
  outputs.relativeSqliteEnvironment = { cwd, variable: 'relative-env', filesUnderCwd: relativeEnvFiles }
  auth(added, 'fixture-account-added', true)
  const inspectorBefore = hash(join(added, 'auth.json')), inspectorRequests = requests.length, inspectorDenied = denied.length
  const guard = new CodexProfileConfiguration(env)
  await guard.verify(added, main, cwd)
  const guards = [{ configuration: 'file/default SQLite', result: 'accepted' }]
  for (const [name, text] of [['auto', config.replace('cli_auth_credentials_store="file"', 'cli_auth_credentials_store="auto"')],
    ['keyring', config.replace('cli_auth_credentials_store="file"', 'cli_auth_credentials_store="keyring"')],
    ['SQLite conflict', `sqlite_home=${JSON.stringify(override)}\n${config}`]]) {
    writeFileSync(join(added, 'config.toml'), text)
    let reason: string | null = null
    try { await guard.verify(added, main, cwd) } catch (error) { reason = (error as Error).message }
    assert.ok(reason)
    guards.push({ configuration: name, result: reason })
  }
  outputs.productionGuard = { guards, authUnchanged: inspectorBefore === hash(join(added, 'auth.json')),
    localRequests: requests.slice(inspectorRequests), deniedRequests: denied.slice(inspectorDenied) }
  writeFileSync(join(added, 'config.toml'), config.replace('trust_level="trusted"', 'trust_level="untrusted"'))
  writeFileSync(join(cwd, '.codex/config.toml'), `sqlite_home=${JSON.stringify(override)}`)
  await guard.verify(added, main, cwd, { yolo: false })
  const launchSettings = { yolo: true, model: 'fixture-model', effort: 'low' }
  const launchOverrides = CodexLaunchConfiguration.of(cwd, launchSettings)
  const trusted = await server(secondEnv, [...launchOverrides.overrides, 'cli_auth_credentials_store="ephemeral"'].flatMap(value => ['-c', value]))
  let trustedConfig: unknown
  try { trustedConfig = await trusted.call('config/read', { includeLayers: true, cwd }) }
  finally { await trusted.close() }
  let trustReason: string | null = null
  try { await guard.verify(added, main, cwd, launchSettings) } catch (error) { trustReason = (error as Error).message }
  assert.match(trustReason ?? '', /sqlite_home must use the main profile home/)
  outputs.launchTrustGuard = { untrustedWithoutYolo: 'accepted', withYolo: trustReason, launchOverrides, trustedConfig,
    authUnchanged: inspectorBefore === hash(join(added, 'auth.json')) }
  unlinkSync(join(cwd, '.codex/config.toml'))
  outputs.requests = requests
  outputs.denied = denied
  outputs.debugHelp = await command(['debug', '--help'], env)
}

try {
  await run()
} catch (error) {
  outputs.failure = error instanceof Error ? error.message : String(error)
  outputs.requests = requests
  outputs.denied = denied
  process.exitCode = 1
} finally {
  for (const child of children) child.kill()
  await waitFor(() => [...children].every(child => child.exitCode !== null || child.signalCode !== null))
  for (const socket of sockets) socket.destroy()
  await Promise.all([api, deny].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  const relativeScratch = relative(root, scratch)
  assert.ok(relativeScratch.startsWith('.aidocs\\temp\\') || relativeScratch.startsWith('.aidocs/temp/'))
  try {
    if (existsSync(join(added, 'sessions'))) unlinkSync(join(added, 'sessions'))
    rmSync(scratch, { recursive: true, maxRetries: 5, retryDelay: 100 })
    outputs.cleaned = true
  } catch (error) {
    outputs.cleaned = false
    outputs.cleanupFailure = (error as Error).message
    process.exitCode = 1
  }
  process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`, () => process.exit(process.exitCode ?? 0))
}
