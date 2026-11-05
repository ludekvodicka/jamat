import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TerminalDescendants, type TerminalDescendant } from '../../app-host/app/terminal/terminalDescendants'
import type { HostDescriptor } from '../../app-host/app/wire/hostWire'
import { RemoteUiScenarios, WorkspaceCdp } from './remoteUiScenarios'
import { LatencyMeasurement, type LatencyBoundary, type LatencySample, type LatencyStatusSample } from './latencyMeasurement'
import { LatencyRenderer } from './latencyRenderer'
import { CliClient } from './cliClient'

interface ForwardReceipt { kind: 'forward'; pid: number; connectionId: string; requestId: string; operation: string; at: number; observedAt: number }
export interface LatencyAttach { client: LatencyClient; id: string; endpoint: string | null; direction: 'local' | 'inbound' | 'outbound' }
export interface LatencyBlock { id: string; start: LatencyBoundary; done: Promise<void> }

export class LatencyClient {
  readonly side: Awaited<ReturnType<typeof RemoteUiScenarios.seed>>
  readonly label: string
  readonly blocks: LatencyBoundary[]
  readonly forwards: ForwardReceipt[]
  private child: ChildProcess | null
  private ui: WorkspaceCdp | null
  private renderer: LatencyRenderer | null
  private output: string
  private lines: string
  private owned: TerminalDescendant[]
  private readonly activeBlocks: Promise<void>[]
  private readonly cliWrapperPath: string

  constructor(label: string, side: LatencyClient['side'], cliWrapperPath: string) {
    this.cliWrapperPath = cliWrapperPath
    this.label = label
    this.side = side
    this.blocks = []
    this.forwards = []
    this.child = null
    this.ui = null
    this.renderer = null
    this.output = ''
    this.lines = ''
    this.owned = []
    this.activeBlocks = []
  }

  static now(): number { return Number(process.hrtime.bigint()) / 1e6 }

  async start(repository: string): Promise<void> {
    assert.equal(process.platform, 'win32', 'The owned-process fixture requires Windows')
    const packageDir = join(repository, 'app-client-ui')
    const env: NodeJS.ProcessEnv = { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: this.side.stateRoot,
      JAMAT_V3_HOST_STATE_DIR: join(this.side.stateRoot, 'host'), JAMAT_V3_CONFIG_DIR: this.side.configDir,
      JAMAT_V3_RUNTIME_CHANNEL: 'development', JAMAT_V3_SKIP_SKILL_LINKS: '1',
      CLAUDE_CONFIG_DIR: this.side.configDir, CODEX_HOME: this.side.configDir }
    delete env.ELECTRON_RUN_AS_NODE
    this.child = spawn(join(packageDir, 'node_modules/electron/dist/electron.exe'), [packageDir, '--smoke', '--smoke-driver',
      `--remote-debugging-port=${this.side.debugPort}`, '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true })
    this.child.stdout!.on('data', bytes => this.receive(bytes.toString()))
    this.child.stderr!.on('data', bytes => { this.output += bytes.toString() })
    this.child.on('error', error => { this.output += String(error) })
    await this.captureOwned()
    this.ui = await WorkspaceCdp.connect(this.side.debugPort)
    const info = await this.ui.bridge<{ configDir: string; configIdentity: string; runtimeChannel: string }>('window.appClient.appInfo()')
    assert.equal(resolve(info.configDir), resolve(this.side.configDir))
    assert.equal(info.configIdentity, this.side.identity.configIdentity)
    assert.equal(info.runtimeChannel, 'development')
    await this.control('host.start', {})
    await RemoteUiScenarios.until(async () => (await this.control('sessions.list', {})).value.host.presence === 'running', `${this.label} Host`)
    this.renderer = new LatencyRenderer()
    await this.renderer.open(this.ui)
    console.log(`[smoke:latency] ${this.label} main PID ${this.child.pid}; private profile ${this.side.configDir}`)
  }

  async control(operation: string, body: object): Promise<any> {
    const result = await this.ui!.bridge<any>(`window.appClient.control.call(${JSON.stringify(operation)}, ${JSON.stringify(body)})`)
    assert(result.ok, `${operation}: ${JSON.stringify(result)}`)
    return result
  }

  async createShell(directory: string): Promise<string> {
    const created = await this.control('sessions.create', { spec: { kind: 'shell', directory: { mode: 'adHoc', path: directory }, title: `Latency ${this.label}` } })
    return created.value.session.sessionId
  }

  async connect(other: LatencyClient, sessionId: string): Promise<void> {
    const endpoint = JSON.stringify(other.side.identity.remoteEndpointId)
    for (const expression of [`window.appClient.remote.connect('network-settings', ${endpoint})`,
      `window.appClient.remote.selectSession(${endpoint}, ${JSON.stringify(sessionId)})`]) {
      const result = await this.ui!.bridge<any>(expression)
      assert(result.ok, JSON.stringify(result))
    }
  }

  async attach(sessionId: string, endpoint: string | null, direction: LatencyAttach['direction']): Promise<LatencyAttach> {
    const id = randomUUID()
    await this.ui!.evaluate(`window.latencySmoke.set(${JSON.stringify(id)}, { writer: false, status: null, marker: null, text: '' })`)
    const args = `${JSON.stringify(id)}, ${JSON.stringify({ sessionId, size: { cols: 160, rows: 40 } })}`
    const result = await this.ui!.bridge<any>(endpoint === null
      ? `window.appClient.terminal.attach(${args})`
      : `window.appClient.remote.terminalAttach(${JSON.stringify(endpoint)}, ${args})`)
    assert(result.ok, JSON.stringify(result))
    await RemoteUiScenarios.until(async () => this.ui!.evaluate<boolean>(`window.latencySmoke.get(${JSON.stringify(id)}).writer === true`), `${direction} writer`)
    return { client: this, id, endpoint, direction }
  }

  async marker(attach: LatencyAttach): Promise<LatencySample> {
    const marker = `M-${randomUUID().replaceAll('-', '')}`
    const command = LatencyMeasurement.command(marker, process.platform)
    const startedAt = LatencyClient.now()
    const answer = await this.renderer!.call({ type: 'marker', attachId: attach.id, endpoint: attach.endpoint, marker, command })
    const arrival = answer.markerAt
    assert(arrival !== null, 'The renderer must deliver the completed output marker')
    return { marker, startedAt, arrivedAt: arrival, milliseconds: arrival - startedAt }
  }

  async block(milliseconds: 3000 | 20000, target: 'orchestrator' | 'main' = 'orchestrator'): Promise<LatencyBlock> {
    const id = randomUUID()
    const done = this.renderer!.call({ type: 'block', id, target, milliseconds }).then(() => {})
    this.activeBlocks.push(done)
    void done.catch(() => {})
    await RemoteUiScenarios.until(async () => this.blocks.some(record => record.id === id && record.phase === 'start'), `${this.label} block entry`, 5000)
    const start = this.blocks.find(record => record.id === id && record.phase === 'start')!
    assert.equal(start.target, target)
    assert.equal(start.process, target)
    assert.equal(start.milliseconds, milliseconds)
    if (target === 'main') assert.equal(start.pid, this.child!.pid)
    else if (target === 'orchestrator') {
      assert.notEqual(start.pid, this.child!.pid)
      assert(this.owned.some(row => row.pid === start.pid), 'Orchestration must be an owned utility process')
    } else throw new Error('Unknown block target')
    console.log('[smoke:latency] confirmed ' + milliseconds + ' ms ' + target + ' block in ' + this.label + ' PID ' + start.pid + ', id ' + id)

    return { id, start, done }
  }

  async status(): Promise<LatencyStatusSample> {
    const cli = new CliClient({ configDir: this.side.configDir, channel: 'development', cwd: this.side.configDir,
      stateRoot: this.side.stateRoot, timeoutMilliseconds: 5000, wrapperPath: this.cliWrapperPath })
    const startedAt = LatencyClient.now()
    const envelope = await cli.run('status')
    const arrivedAt = LatencyClient.now()
    const status = CliClient.valueOf(envelope, 'system.status')
    const identity = CliClient.object(status.identity, 'status identity')
    assert.equal(identity.configIdentity, this.side.identity.configIdentity)
    assert.equal(identity.runtimeChannel, 'development')
    console.log('[smoke:latency] distributed CLI wrapper ' + this.cliWrapperPath + '; launch and discovery included')
    return { operation: 'system.status', startedAt, arrivedAt, milliseconds: arrivedAt - startedAt }
  }

  async end(block: LatencyBlock): Promise<LatencyBoundary> {
    await block.done
    await RemoteUiScenarios.until(async () => this.blocks.some(record => record.id === block.id && record.phase === 'end'), `${this.label} block end`, 5000)
    return this.blocks.find(record => record.id === block.id && record.phase === 'end')!
  }

  async pending(other: LatencyClient): Promise<{ settledAt(): number | null; receipt: ForwardReceipt; done: Promise<any> }> {
    await other.readForwards()
    const before = other.forwards.length
    let settledAt: number | null = null
    const done = this.renderer!.call({ type: 'projects', endpoint: other.side.identity.remoteEndpointId })
      .then(result => { settledAt = LatencyClient.now(); return result.value }, error => { settledAt = LatencyClient.now(); throw error })
    void done.catch(() => {})
    await RemoteUiScenarios.until(async () => {
      await other.readForwards()
      return other.forwards.slice(before).some(value => value.operation === 'projects.list')
    }, 'Forwarded projects.list receipt', 2000)
    const receipts = other.forwards.slice(before).filter(value => value.operation === 'projects.list')
    assert.equal(receipts.length, 1, 'Exactly one request must correlate with this pending call')
    assert.equal(settledAt, null, 'Forwarded request must still be pending at gateway admission')
    assert.notEqual(receipts[0]!.pid, other.child!.pid, 'The gateway must emit its own receipt')
    console.log(`[smoke:latency] externally observed gateway PID ${receipts[0]!.pid} forwarded request ${receipts[0]!.requestId} on ${receipts[0]!.connectionId}`)
    return { settledAt: () => settledAt, receipt: receipts[0]!, done }
  }

  async captureOwned(): Promise<void> {
    const child = this.child
    if (process.platform !== 'win32') throw new Error('Owned process capture currently requires Windows')
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}').CreationDate | ForEach-Object { ([DateTimeOffset]$_).ToUnixTimeMilliseconds() }`],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status, 0, result.stderr)
      const startedAt = Number(result.stdout.trim())
      assert(Number.isSafeInteger(startedAt) && startedAt > 0)
      const main = { pid: child.pid, startedAt }
      this.owned = [...new Map([...this.owned, main].map(row => [row.pid, row])).values()]
      this.owned = [...new Map([...this.owned, ...await TerminalDescendants.capture(main.pid, main.startedAt)].map(row => [row.pid, row])).values()]
    }
    try {
      const descriptor = await this.descriptor()
      const host = { pid: descriptor.pid, startedAt: descriptor.processStartedAt }
      this.owned = [...new Map([...this.owned, host].map(row => [row.pid, row])).values()]
      this.owned = [...new Map([...this.owned, ...await TerminalDescendants.capture(host.pid, host.startedAt)].map(row => [row.pid, row])).values()]
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    console.log(`[smoke:latency] owned ${this.label}: ${JSON.stringify(this.owned)}`)
  }

  async retire(): Promise<void> {
    await Promise.allSettled(this.activeBlocks)
    try {
      await this.captureOwned()
      if (this.ui && this.child?.exitCode === null && this.child.signalCode === null) {
        const descriptor = await this.descriptor()
        await this.control('host.stop', { expectedHostInstanceId: descriptor.hostInstanceId })
        await this.ui.evaluate('window.close()').catch(() => {})
      }
    } finally {
      let bridgeError: unknown
      try { await this.renderer?.close() }
      catch (error) { bridgeError = error }
      this.ui?.close()
      try {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null)
          await RemoteUiScenarios.until(async () => this.child!.exitCode !== null || this.child!.signalCode !== null, `${this.label} normal quit`, 10000).catch(() => this.child!.kill())
        await TerminalDescendants.stop(this.owned)
        await RemoteUiScenarios.until(async () => this.owned.every(row => {
          try { process.kill(row.pid, 0); return false } catch { return true }
        }), `${this.label} owned processes stopped`, 10000)
        console.log(`[smoke:latency] stopped ${this.label}: ${JSON.stringify(this.owned.map(row => row.pid))}`)
      } finally { console.log(`[smoke:latency] complete ${this.label} child output:\n${this.output}`) }
      if (bridgeError) throw bridgeError
    }
  }

  private async descriptor(): Promise<HostDescriptor> {
    const descriptor = JSON.parse(await readFile(this.side.hostFile, 'utf8')) as HostDescriptor
    assert.equal(descriptor.configIdentity, this.side.identity.configIdentity)
    assert.equal(descriptor.runtimeChannel, 'development')
    return descriptor
  }

  private async readForwards(): Promise<void> {
    let text: string
    try { text = await readFile(join(this.side.clientStateDirectory, 'latency-forward.jsonl'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    assert(Buffer.byteLength(text) < 65536, 'Fixture forward receipts stay bounded')
    const lines = text.split('\n').slice(0, -1)
    assert(lines.length >= this.forwards.length, 'Fixture receipt history must not be replaced')
    for (const line of lines.slice(this.forwards.length)) {
      const record = JSON.parse(line)
      assert.equal(record.kind, 'forward')
      assert.equal(typeof record.requestId, 'string')
      assert.equal(typeof record.connectionId, 'string')
      assert.equal(typeof record.operation, 'string')
      assert(Number.isSafeInteger(record.pid) && record.pid > 0 && Number.isFinite(record.at))
      this.forwards.push({ ...record, observedAt: LatencyClient.now() })
    }
  }

  private receive(text: string): void {
    this.output += text
    this.lines += text
    let newline: number
    while ((newline = this.lines.indexOf('\n')) !== -1) {
      const line = this.lines.slice(0, newline).trim()
      this.lines = this.lines.slice(newline + 1)
      if (!line.startsWith('[latency-smoke] ')) continue
      const value = { ...JSON.parse(line.slice('[latency-smoke] '.length)), observedAt: LatencyClient.now() }
      if (value.kind === 'block') this.blocks.push(value)
      else throw new Error(`Unknown latency receipt: ${line}`)
    }
  }
}
