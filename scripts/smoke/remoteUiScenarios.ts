import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { ConfigStore } from '../../lib-orchestrator/configStore/configStore.js'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing.js'

const requireUi = createRequire(import.meta.url)
const { RemotePeerCredentialStore } = requireUi('../../app-client-ui/app/remoteControl/remotePeerCredentialStore.ts') as typeof import('../../app-client-ui/app/remoteControl/remotePeerCredentialStore.js')
const { RemoteEndpointIdentityStore } = requireUi('../../app-client-ui/app/remoteControl/remoteEndpointIdentityStore.ts') as typeof import('../../app-client-ui/app/remoteControl/remoteEndpointIdentityStore.js')
const { RemoteControlSettingsSection } = requireUi('../../app-client-ui/app/remoteControl/remoteControlSettingsSection.ts') as typeof import('../../app-client-ui/app/remoteControl/remoteControlSettingsSection.js')
const { RemoteControlSettings } = requireUi('../../app-client-ui/shared/remoteControlSettings.ts') as typeof import('../../app-client-ui/shared/remoteControlSettings.js')
const { ClientStatePaths } = requireUi('../../app-client-ui/app/clientState/clientStatePaths.ts') as typeof import('../../app-client-ui/app/clientState/clientStatePaths.js')

export class WorkspaceCdp {
  private readonly socket: WebSocket
  readonly responses = new Map<string, { status: number; headers: Record<string, string> }>()
  private serial = 0
  private readonly pending = new Map<number, { resolve(value: any): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>()

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (bytes) => {
      const answer = JSON.parse(bytes.toString())
      if (answer.method === 'Network.responseReceived') this.responses.set(answer.params.response.url, { status: answer.params.response.status, headers: answer.params.response.headers })
      const pending = this.pending.get(answer.id)
      if (!pending) return
      this.pending.delete(answer.id); clearTimeout(pending.timer)
      if (answer.error) pending.reject(new Error(JSON.stringify(answer.error)))
      else pending.resolve(answer.result)
    })
  }

  static async connect(port: number): Promise<WorkspaceCdp> {
    let url: string | undefined
    await RemoteUiScenarios.until(async () => {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as { type: string; webSocketDebuggerUrl: string; url: string }[]
        url = pages.find((page) => page.type === 'page' && page.url.includes('index.html'))?.webSocketDebuggerUrl
        return !!url
      } catch { return false }
    }, 'Electron renderer debug port')
    const socket = new WebSocket(url!)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const client = new WorkspaceCdp(socket)
    // Occluded smoke windows must keep layout and lazy media loading active.
    await client.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    await RemoteUiScenarios.until(async () => client.evaluate<boolean>('Boolean(window.appClient && document.querySelector(".dv-dockview"))'), 'Mounted workspace')
    return client
  }

  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails))
    return answer.result.value as T
  }

  async bridge<T>(expression: string): Promise<T> {
    return this.evaluate(`(async () => { const result = await ${expression}; if (!result.ok) throw new Error(JSON.stringify(result)); return result.value })()`)
  }

  async capture(path: string): Promise<void> {
    await this.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    const result = await this.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path, Buffer.from(result.data, 'base64'))
  }

  close(): void { this.socket.close() }
}

export class RemoteUiScenarios {
  static async until(condition: () => Promise<boolean>, subject: string, timeoutMs = 60000): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await condition()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out: ${subject}`)
  }

  static async port(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    return port
  }

  static async seed(root: string, label: string) {
    const stateRoot = join(root, label, 'state'), configDir = join(root, label, 'config')
    await mkdir(configDir, { recursive: true })
    process.env.JAMAT_V3_LOCAL_STATE_DIR = stateRoot
    const { configIdentity } = ConfigIdentityStore.loadOrCreate(configDir, 'development')
    const credentials = RemotePeerCredentialStore.loadOrCreate(ClientStatePaths.remotePeerCredentialsFile(), ClientStatePaths.remoteMachineIdentityFile(), {
      computerId: () => `ui-smoke-${label}`, displayName: () => `UI smoke ${label}`,
    })
    const identity = RemoteEndpointIdentityStore.loadOrCreate(ClientStatePaths.remoteEndpointIdentityFile(configIdentity, 'development'),
      credentials.machineIdentity(), configIdentity, 'development', () => `ui-smoke-endpoint-${label}`).identity(credentials.machineIdentity())
    const config = ConfigStore.load(configDir, { snapshotsDirectory: join(stateRoot, 'snapshots'), report: (detail) => { throw new Error(detail) } })
    process.env.JAMAT_V3_HOST_STATE_DIR = join(stateRoot, 'host')
    const hostFile = HostDescriptorPaths.descriptorFile(configIdentity, 'development')
    return { stateRoot, configDir, config, credentials, identity, hostFile, port: await this.port(), debugPort: await this.port() }
  }

  static pair(source: Awaited<ReturnType<typeof RemoteUiScenarios.seed>>, controller: Awaited<ReturnType<typeof RemoteUiScenarios.seed>>): void {
    source.credentials.trustInbound(controller.identity)
    assert(source.config.saveSection(RemoteControlSettingsSection.spec, { profiles: [], listener: {
      enabled: true, bindHost: '127.0.0.1', advertisedHost: '127.0.0.1', port: source.port,
    } }).ok)
    assert(controller.config.saveSection(RemoteControlSettingsSection.spec, { ...RemoteControlSettings.defaultValue(), profiles: [
      RemoteControlPairing.profile(RemoteControlPairing.bundle(source.identity, { host: '127.0.0.1', port: source.port })),
    ] }).ok)
  }

  private static async review(source: WorkspaceCdp, controller: WorkspaceCdp, endpoint: string, root: string, screenshotRoot: string, vcs: 'svn' | 'git'): Promise<void> {
    const working = join(root, `review-${vcs}`)
    const run = async (command: string, cwd: string, args: string[]): Promise<string> => {
      const result = await new CommandInvoker().run({ command, cwd, args, env: process.env })
      assert.equal(result.code, 0, result.stderr || JSON.stringify(result))
      return result.stdout.trim()
    }
    if (vcs === 'svn') {
      const repository = join(root, 'ui-svn-repository')
      await run('svnadmin', root, ['create', repository])
      await run(vcs, root, ['checkout', pathToFileURL(repository).href, working])
    } else if (vcs === 'git') {
      await mkdir(working)
      await run(vcs, working, ['init', '--initial-branch=main'])
      await run(vcs, working, ['config', 'user.name', 'Smoke Fixture'])
      await run(vcs, working, ['config', 'user.email', 'smoke@example.invalid'])
    } else throw new Error(`Unknown fixture VCS: ${vcs}`)
    for (let i = 0; i < 40; i++) await writeFile(join(working, `change-${String(i).padStart(2, '0')}.txt`), 'base source content')
    await run(vcs, working, ['add', '--', ...Array.from({ length: 40 }, (_, i) => `change-${String(i).padStart(2, '0')}.txt`)])
    const messageFile = join(root, `${vcs}-seed.txt`)
    await writeFile(messageFile, 'Disposable UI review fixture')
    await run(vcs, working, ['commit', '--file', messageFile])
    for (let i = 0; i < 40; i++) await writeFile(join(working, `change-${String(i).padStart(2, '0')}.txt`), 'edited source content')
    const title = `Shared ${vcs.toUpperCase()} review`
    const created = await source.bridge<any>(`window.appClient.control.call('sessions.create', { spec: { kind: 'shell', directory: { mode: 'adHoc', path: ${JSON.stringify(working)} }, title: ${JSON.stringify(title)} } })`)
    assert(created.ok, JSON.stringify(created))
    const id = created.value.session.sessionId
    const selected = await controller.bridge<any>(`window.appClient.remote.selectSession(${JSON.stringify(endpoint)}, ${JSON.stringify(id)})`)
    assert(selected.ok, JSON.stringify(selected))
    await source.bridge(`window.appClient.control.call('tabs.open', { session: { kind: 'sessionId', sessionId: ${JSON.stringify(id)} } })`)
    await this.until(async () => controller.evaluate<boolean>(`Array.from(document.querySelectorAll('.jamat-sessions__title')).some(e => e.textContent === ${JSON.stringify(title)})`), title)
    await controller.evaluate(`Array.from(document.querySelectorAll('.jamat-sessions__title')).find(e => e.textContent === ${JSON.stringify(title)}).click()`)
    await this.until(async () => controller.evaluate<boolean>(`!!document.querySelector('.xterm')`), 'Review session terminal')
    const opened = await source.bridge<any>(`window.appClient.versioning.openCommitTab(${JSON.stringify(id)}, ${JSON.stringify(vcs)})`)
    assert(opened.ok, JSON.stringify(opened))
    for (const ui of [source, controller])
      await this.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.commit-pane')).some(p => p.getBoundingClientRect().height > 0 && p.querySelectorAll('.commit-target').length === 40)`), 'Shared review rows')
    const author = vcs === 'svn' ? controller : source, observer = vcs === 'svn' ? source : controller
    await new Promise((resolve) => setTimeout(resolve, 500))
    const message = `Publish selected ${vcs.toUpperCase()} change from a shared review`
    await author.evaluate(`Array.from(document.querySelectorAll('.commit-message textarea')).find(e => e.getBoundingClientRect().height > 0).focus()`)
    assert(await author.evaluate<boolean>(`document.activeElement.matches('.commit-message textarea')`))
    await author.call('Input.insertText', { text: message })
    await this.until(async () => observer.evaluate<boolean>(`Array.from(document.querySelectorAll('.commit-message textarea')).some(e => e.value === ${JSON.stringify(message)})`), 'Same commit message in both windows')
    await author.evaluate(`Array.from(document.querySelectorAll('.commit-pane button')).find(e => e.textContent === 'Select none' && e.getBoundingClientRect().height > 0).click()`)
    await this.until(async () => author.evaluate<boolean>(`Array.from(document.querySelectorAll('.commit-target input')).filter(e => e.checked).length === 0`), 'Cleared shared selection')
    await author.evaluate(`Array.from(document.querySelectorAll('.commit-target input')).find(e => e.getAttribute('aria-label') === 'Include change-00.txt' && e.getBoundingClientRect().height > 0).click()`)
    await this.until(async () => observer.evaluate<boolean>(`Array.from(document.querySelectorAll('.commit-target input')).filter(e => e.checked).length === 1`), 'Same selected path in both windows')
    for (const width of [1440, 1000]) {
      await author.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await this.until(async () => author.evaluate<boolean>(`(() => { const pane = Array.from(document.querySelectorAll('.commit-pane')).find(e => e.getBoundingClientRect().height > 0); const list = pane.querySelector('.commit-files'), box = pane.querySelector('textarea'), submit = pane.querySelector('.commit-submit'); return list.clientHeight > 100 && list.scrollHeight > list.clientHeight && box.clientHeight > 80 && submit.getBoundingClientRect().bottom < innerHeight && !submit.disabled; })()`), 'Usable review geometry and approval')
    }
    await author.evaluate(`Array.from(document.querySelectorAll('.commit-message textarea')).find(e => e.getBoundingClientRect().height > 0).focus()`)
    await author.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await author.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    assert(await author.evaluate<boolean>(`document.activeElement.matches('.commit-submit')`), 'Tab reaches the enabled commit action from the message')
    if (vcs === 'svn') await author.capture(join(screenshotRoot, 'remote-parity-dual-review-1440x900.png'))
    await author.evaluate(`Array.from(document.querySelectorAll('.commit-submit')).find(e => e.getBoundingClientRect().height > 0).click()`)
    await this.until(async () => (await run(vcs, working, vcs === 'svn' ? ['log', '--xml', '-r', '1:HEAD'] : ['rev-list', '--count', 'HEAD'])).includes(vcs === 'svn' ? message : '2'), 'One actual source publication')
    const history = await run(vcs, working, vcs === 'svn' ? ['log', '--xml', '-r', '1:HEAD'] : ['rev-list', '--count', 'HEAD'])
    assert.equal(vcs === 'svn' ? history.match(/<logentry/g)?.length : Number(history), 2)
    const status = await run(vcs, working, vcs === 'svn' ? ['status'] : ['status', '--porcelain'])
    assert(!status.includes('change-00.txt') && status.includes('change-01.txt'))
    console.log(`[smoke:ui] two real windows share ${vcs} selection/message; ${vcs === 'svn' ? 'controller' : 'source'} approval publishes once and keeps unselected work`)
  }

  static async run(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'jamat-remote-ui-'))
    const repo = join(import.meta.dirname, '..', '..')
    const screenshotRoot = join(repo, '.aidocs', 'screenshots')
    await mkdir(screenshotRoot, { recursive: true })
    const previousState = process.env.JAMAT_V3_LOCAL_STATE_DIR
    const previousHost = process.env.JAMAT_V3_HOST_STATE_DIR
    const children: ChildProcess[] = [], clients: WorkspaceCdp[] = [], hosts: string[] = []
    const logs: { label: string; text: string }[] = []
    try {
      const source = await this.seed(root, 'source'), controller = await this.seed(root, 'controller')
      hosts.push(source.hostFile, controller.hostFile)
      this.pair(source, controller)
      for (const [label, side] of [['source', source], ['controller', controller]] as const) {
        const env: NodeJS.ProcessEnv = { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: side.stateRoot, JAMAT_V3_HOST_STATE_DIR: join(side.stateRoot, 'host'),
          JAMAT_V3_CONFIG_DIR: side.configDir, JAMAT_V3_RUNTIME_CHANNEL: 'development', JAMAT_V3_SKIP_SKILL_LINKS: '1', CLAUDE_CONFIG_DIR: side.configDir, CODEX_HOME: side.configDir }
        delete env.ELECTRON_RUN_AS_NODE
        const child = spawn(join(repo, 'app-client-ui/node_modules/electron/dist/electron.exe'), [join(repo, 'app-client-ui'),
          `--remote-debugging-port=${side.debugPort}`, '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true })
        children.push(child)
        const log = { label, text: '' }; logs.push(log)
        child.stdout?.on('data', (bytes) => { log.text += bytes.toString() })
        child.stderr?.on('data', (bytes) => { log.text += bytes.toString() })
        clients.push(await WorkspaceCdp.connect(side.debugPort))
      }
      const [sourceUi, controllerUi] = clients
      await this.until(async () => {
        const answer = await sourceUi!.bridge<any>(`window.appClient.control.call('sessions.list', {})`)
        return answer.ok && answer.value.host.presence === 'running'
      }, 'Source Host ready')
      const workspace = join(root, 'source-project'); await mkdir(workspace)
      await writeFile(join(workspace, 'report.md'), '# Remote workspace\n\nThis document belongs to the source computer.\n\n![Source image](image.png)\n')
      await writeFile(join(workspace, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="600" height="240" fill="#163b55"/><text x="40" y="130" fill="white" font-size="36">Source computer image</text></svg>')
      await writeFile(join(workspace, 'image.png'), await readFile(join(repo, 'app-client-ui/buildResources/icon.png')))
      const created = await sourceUi!.bridge<any>(`window.appClient.control.call('sessions.create', { spec: { kind: 'shell', directory: { mode: 'adHoc', path: ${JSON.stringify(workspace)} }, title: 'Remote workspace proof' } })`)
      assert(created.ok, JSON.stringify(created))
      const sessionId = created.value.session.sessionId
      await sourceUi!.bridge(`window.appClient.control.call('tabs.open', { session: { kind: 'sessionId', sessionId: ${JSON.stringify(sessionId)} } })`)
      const endpoint = source.identity.remoteEndpointId
      const connected = await controllerUi!.bridge<any>(`window.appClient.remote.connect('network-settings', ${JSON.stringify(endpoint)})`)
      assert(connected.ok, JSON.stringify(connected))
      const selected = await controllerUi!.bridge<any>(`window.appClient.remote.selectSession(${JSON.stringify(endpoint)}, ${JSON.stringify(sessionId)})`)
      assert(selected.ok, JSON.stringify(selected))
      await this.until(async () => (await controllerUi!.evaluate<string>('document.body.innerText')).includes('Remote workspace proof'), 'Source session in remote tree')
      await controllerUi!.evaluate(`Array.from(document.querySelectorAll('.jamat-sessions__title')).find(e => e.textContent === 'Remote workspace proof').click()`)
      await this.until(async () => controllerUi!.evaluate<boolean>(`!!document.querySelector('.xterm')`), 'Remote terminal mounted')
      const opened = await sourceUi!.bridge<any>(`window.appClient.control.call('tabs.openFile', { session: { kind: 'sessionId', sessionId: ${JSON.stringify(sessionId)} }, path: ${JSON.stringify(join(workspace, 'report.md'))} })`)
      assert(opened.ok, JSON.stringify(opened))
      await this.until(async () => (await controllerUi!.evaluate<string>('document.body.innerText')).includes('This document belongs to the source computer.'), 'Shared Markdown rendered')
      await this.until(async () => controllerUi!.evaluate<boolean>(`Array.from(document.images).some(image => image.naturalWidth > 0)`), 'Source relative image loaded')
      const mediaUrl = await controllerUi!.evaluate<string>(`Array.from(document.images).find(image => image.naturalWidth > 0).src`)
      await controllerUi!.call('Network.enable')
      await controllerUi!.call('Network.setExtraHTTPHeaders', { headers: { Range: 'bytes=1-7' } })
      const rangeUrl = `${mediaUrl}?range-probe`
      await controllerUi!.evaluate(`new Promise(resolve => { const image = new Image(); image.onload = image.onerror = () => resolve(null); image.src = ${JSON.stringify(rangeUrl)} })`)
      await controllerUi!.call('Network.setExtraHTTPHeaders', { headers: {} })
      const range = controllerUi!.responses.get(rangeUrl)
      assert.equal(range?.status, 206)
      assert(Object.entries(range!.headers).some(([name, value]) => name.toLowerCase() === 'content-range' && value.startsWith('bytes 1-7/')), JSON.stringify(range))
      console.log('[smoke:ui] shared source Markdown and relative image render; Electron serves a partial remote range')
      await controllerUi!.capture(join(screenshotRoot, 'remote-parity-rich-previews-1440x900.png'))
      await writeFile(join(workspace, 'image.png'), 'changed on source')
      const changedUrl = `${mediaUrl}?changed-probe`
      await controllerUi!.evaluate(`new Promise(resolve => { const image = new Image(); image.onload = image.onerror = () => resolve(null); image.src = ${JSON.stringify(changedUrl)} })`)
      assert.equal(controllerUi!.responses.get(changedUrl)?.status, 409)
      await this.review(sourceUi!, controllerUi!, endpoint, root, screenshotRoot, 'svn')
      await this.review(sourceUi!, controllerUi!, endpoint, root, screenshotRoot, 'git')
    } catch (error) {
      for (const client of clients) console.error('UI state:', await client.evaluate('document.body.innerText').catch(String))
      for (const log of logs) console.error(`${log.label}: ${log.text.slice(-6000)}`)
      throw error
    } finally {
      for (const client of clients) client.close()
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        child.kill()
        await this.until(async () => child.exitCode !== null || child.signalCode !== null, 'Disposable client stopped')
      }
      for (const file of hosts) {
        try {
          const descriptor = JSON.parse(await readFile(file, 'utf8'))
          process.kill(descriptor.pid)
          await this.until(async () => { try { process.kill(descriptor.pid, 0); return false } catch { return true } }, 'Disposable Host stopped')
        } catch {}
      }
      if (previousHost === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
      else process.env.JAMAT_V3_HOST_STATE_DIR = previousHost
      if (previousState === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
      else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousState
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Smoke cleanup retained ${root}: ${String(error)}`))
    }
  }
}

if (process.argv.includes('--standalone')) void RemoteUiScenarios.run().catch((error) => { console.error(error); process.exitCode = 1 })
