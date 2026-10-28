import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { WebSocket } from 'ws'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths.js'
import { RemoteUiScenarios, WorkspaceCdp } from './remoteUiScenarios.js'

export class UsageUiScenario {
  static async run(): Promise<void> {
    const repo = join(import.meta.dirname, '../..'), parent = join(repo, '.aidocs/temp')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'usage-ui-')), config = join(root, 'config'), state = join(root, 'state')
    const claude = join(root, 'claude'), codex = join(root, 'codex'), project = join(root, 'projects/JamatProof')
    const screenshotRoot = join(repo, '.aidocs/screenshots')
    const previousState = process.env.JAMAT_V3_LOCAL_STATE_DIR, previousHost = process.env.JAMAT_V3_HOST_STATE_DIR
    const clients: WorkspaceCdp[] = []
    let child: ChildProcess | null = null, hostFile: string | null = null, log = ''
    try {
      for (const directory of [config, claude, codex, project, screenshotRoot]) await mkdir(directory, { recursive: true })
      process.env.JAMAT_V3_LOCAL_STATE_DIR = state
      process.env.JAMAT_V3_HOST_STATE_DIR = join(state, 'host')
      const { configIdentity } = ConfigIdentityStore.loadOrCreate(config, 'development')
      hostFile = HostDescriptorPaths.descriptorFile(configIdentity, 'development')
      await writeFile(join(config, 'config.json'), JSON.stringify({ schemaVersion: 1,
        categories: [{ id: 'fixture', label: 'Fixture', path: join(root, 'projects') }],
        accounts: [{ id: 'work-fixture', agentId: 'claude', label: 'Work fixture', enabled: true,
          identity: { key: 'fixture/work@example.invalid', label: 'work@example.invalid' } }],
      }))
      const workHome = join(config, 'accounts/claude/work-fixture')
      await mkdir(workHome, { recursive: true })
      await writeFile(join(workHome, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'fixture', emailAddress: 'work@example.invalid' } }))
      const now = Date.now(), hour = 3_600_000
      const windows = (used: number, reset: number) => [{ durationMinutes: 10080, usedPercent: used, resetsAt: new Date(reset).toISOString() },
        { durationMinutes: 300, usedPercent: used / 2, resetsAt: new Date(now + hour).toISOString() }]
      const accounts = [
        { key: { agentId: 'claude' as const, accountId: 'main' }, entry: { fetchedAt: now, extras: [], windows: windows(20, now + 5 * 24 * hour) }, attemptAt: now },
        { key: { agentId: 'claude' as const, accountId: 'work-fixture' }, entry: { fetchedAt: now, extras: [], windows: windows(25, now + 2 * hour) }, attemptAt: now },
        { key: { agentId: 'codex' as const, accountId: 'main' }, entry: { fetchedAt: now, extras: [], windows: windows(35, now + 3 * 24 * hour) }, attemptAt: now },
      ]
      await mkdir(OrchestratorPaths.directory(configIdentity, 'development'), { recursive: true })
      await writeFile(OrchestratorPaths.rateMonitorCacheFile(configIdentity, 'development'), JSON.stringify({ schemaVersion: 2, accounts }))
      const history = OrchestratorPaths.rateHistoryDirectory(configIdentity, 'development')
      await mkdir(history, { recursive: true })
      const samples = accounts.flatMap(account => [3, 2, 1, 0].map(hours => ({ at: now - hours * hour, ...account.key,
        source: 'poll', windows: windows(account.entry.windows[0].usedPercent - hours * 3, Date.parse(account.entry.windows[0].resetsAt!)) })))
      const months = new Map<string, typeof samples>()
      for (const sample of samples) {
        const month = new Date(sample.at).toISOString().slice(0, 7)
        months.set(month, [...months.get(month) ?? [], sample])
      }
      for (const [month, entries] of months) await writeFile(join(history, `${month}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      await mkdir(join(claude, 'projects/fixture'), { recursive: true })
      await mkdir(join(codex, 'sessions'), { recursive: true })
      await writeFile(join(claude, 'projects/fixture/native.jsonl'), [0, 1, 2, 3].map(day => JSON.stringify({
        type: 'assistant', timestamp: new Date(now - day * 86_400_000).toISOString(), cwd: project, sessionId: 'native', requestId: `r${day}`,
        message: { id: `m${day}`, model: 'fixture-model', usage: { input_tokens: 1200 + day * 300, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 } },
      })).join('\n') + '\n')
      await writeFile(join(codex, 'sessions/rollout-fixture.jsonl'), [
        { type: 'session_meta', payload: { id: 'codex-native', cwd: project } },
        { type: 'turn_context', payload: { model: 'fixture-model' } },
        { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 2500, cached_input_tokens: 500, output_tokens: 800, reasoning_output_tokens: 200 },
        } } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
      await writeFile(join(root, 'package.json'), JSON.stringify({ main: 'fixture.cjs' }))
      await writeFile(join(root, 'fixture.cjs'), UsageUiScenario.fixtureSource(repo))
      const port = await RemoteUiScenarios.port()
      const env: NodeJS.ProcessEnv = { ...process.env, JAMAT_V3_CONFIG_DIR: config, JAMAT_V3_LOCAL_STATE_DIR: state,
        JAMAT_V3_HOST_STATE_DIR: join(state, 'host'), JAMAT_V3_RUNTIME_CHANNEL: 'development', JAMAT_V3_SKIP_SKILL_LINKS: '1',
        CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.CODEX_SQLITE_HOME
      child = spawn(join(repo, 'app-client-ui/node_modules/electron/dist/electron.exe'), [root,
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true })
      child.stdout?.on('data', bytes => { log += bytes.toString() })
      child.stderr?.on('data', bytes => { log += bytes.toString() })
      await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject) })
      await RemoteUiScenarios.until(async () => {
        if (child!.exitCode !== null || child!.signalCode !== null) throw new Error('Usage client exited before its private Host was ready')
        try {
          const host = JSON.parse(await readFile(hostFile!, 'utf8'))
          const spawned: number[] = JSON.parse(await readFile(join(root, 'host-pids.json'), 'utf8'))
          return Number.isInteger(host.pid) && spawned.includes(host.pid)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false
          throw error
        }
      }, 'Usage private Host descriptor', 90_000)
      clients.push(await WorkspaceCdp.connect(port))
      await RemoteUiScenarios.until(async () => (await clients[0].bridge<any>("window.appClient.control.call('sessions.list', {})")).value.host.presence === 'running',
        'Usage workspace initialized and connected to its private Host')
      const command = async (id: number, action: 'open' | 'close') => {
        await writeFile(join(root, 'command.json'), JSON.stringify({ id, action }))
        let result: { id: number; windows: { id: number; focuses: number }[] } | null = null
        await RemoteUiScenarios.until(async () => {
          try { result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')); return result?.id === id } catch { return false }
        }, `Usage ${action} command`)
        return result as unknown as { id: number; windows: { id: number; focuses: number }[] }
      }
      const first = await command(1, 'open')
      assert.equal(first.windows.length, 1)
      const second = await command(2, 'open')
      assert.equal(second.windows[0].id, first.windows[0].id)
      assert.equal(second.windows[0].focuses, 1)
      const ui = await UsageUiScenario.connectUsage(port)
      clients.push(ui)
      await RemoteUiScenarios.until(() => ui.evaluate<boolean>('document.querySelectorAll(".jamat-usage__cards article").length === 3 && document.querySelectorAll(".jamat-usage__graph svg").length >= 4'), 'Quota cards and four Vega charts')
      assert((await ui.evaluate<string>('document.body.innerText')).includes('155% of 200%'))
      assert((await ui.evaluate<string>('document.body.innerText')).includes('JamatProof'))
      await ui.capture(join(screenshotRoot, 'phase3-usage-overview-1440x900.png'))
      await ui.evaluate('document.querySelector(".jamat-usage__tokens").scrollIntoView()')
      await ui.capture(join(screenshotRoot, 'phase3-usage-tokens-1440x900.png'))
      const tokens = await ui.bridge<any>(`window.appClient.control.call('usage.tokens', { from: '${new Date(now - 6 * 86_400_000).toISOString().slice(0, 10)}', to: '${new Date(now + 86_400_000).toISOString().slice(0, 10)}', groupBy: 'project' })`)
      assert.equal(tokens.value.rows.length, 2)
      assert.equal(tokens.value.rows.find((row: { agentId: string }) => row.agentId === 'codex').input, 2000)
      await command(3, 'close')
      await RemoteUiScenarios.until(async () => !(await UsageUiScenario.pages(port)).some(page => page.url.includes('usage.html')), 'Usage window closed')
      const reopened = await command(4, 'open')
      assert.equal(reopened.windows.length, 1)
      assert.notEqual(reopened.windows[0].id, first.windows[0].id)
      console.log('[smoke:ui] Usage menu opens, focuses, closes and reopens one isolated window; account pools, reset projection and both agents token totals render')
    } catch (error) {
      console.error(log)
      throw error
    } finally {
      for (const client of clients) client.close()
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await RemoteUiScenarios.until(async () => child!.exitCode !== null || child!.signalCode !== null, 'Usage client stopped')
      }
      // A detached Host can publish its descriptor after an early client failure. Its spawn receipt
      // exists synchronously, before the child can outlive the fixture's cleanup.
      let hostPids: number[] = []
      try { hostPids = JSON.parse(await readFile(join(root, 'host-pids.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const hostPid of hostPids) {
        if (!Number.isInteger(hostPid) || hostPid <= 0) throw new Error('Invalid Usage fixture Host spawn receipt')
        try { process.kill(hostPid) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        await RemoteUiScenarios.until(async () => { try { process.kill(hostPid, 0); return false } catch { return true } }, 'Usage Host stopped')
      }
      if (previousState === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
      else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousState
      if (previousHost === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
      else process.env.JAMAT_V3_HOST_STATE_DIR = previousHost
      const [actualParent, actualRoot, metadata] = await Promise.all([realpath(parent), realpath(root), lstat(root)])
      const within = relative(actualParent, actualRoot)
      if (!within || within.startsWith('..') || isAbsolute(within) || metadata.isSymbolicLink())
        throw new Error(`Refusing Usage fixture cleanup outside its temp parent: ${actualRoot}`)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  static fixtureSource(repo: string): string {
    return [
        "const electron = require('electron'), Module = require('node:module'), fs = require('node:fs'), path = require('node:path')",
        'const OriginalWindow = electron.BrowserWindow',
        'class HiddenWindow extends OriginalWindow {',
        ' fixtureFocuses',
        ' fixtureTitle',
        ' constructor(options) { super({ ...options, show: false, focusable: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true } }); this.fixtureFocuses = 0; this.fixtureTitle = options.title }',
        ' show() {} focus() { this.fixtureFocuses++ } restore() {} maximize() {}',
        '}',
        "const isolated = Object.create(electron, { BrowserWindow: { value: HiddenWindow } }), load = Module._load",
        "Module._load = function(name, ...args) { return name === 'electron' ? isolated : load.call(this, name, ...args) }",
        "const children = require('node:child_process'), spawn = children.spawn, hostPids = []",
        'children.spawn = function(command, args, options) {',
        ' const child = spawn.call(this, command, args, options)',
        " if (options?.detached && options.env?.JAMAT_V3_HOST_STATE_DIR === path.join(__dirname, 'state/host') && args?.includes(path.join(__dirname, 'config')) && child.pid) {",
        "  hostPids.push(child.pid); fs.writeFileSync(path.join(__dirname, 'host-pids.json'), JSON.stringify(hostPids))",
        ' }',
        ' return child',
        '}',
        'electron.Notification.prototype.show = () => {}',
        `electron.app.setAppPath(${JSON.stringify(join(repo, 'app-client-ui'))})`,
        'let last = 0, dispatched = 0',
        'setInterval(() => { try {',
        " const command = JSON.parse(fs.readFileSync(path.join(__dirname, 'command.json'), 'utf8'))",
        ' if (command.id === last) return',
        " const usage = () => electron.BaseWindow.getAllWindows().filter(window => window.fixtureTitle === 'Jamat Usage')",
        ' if (dispatched !== command.id) {',
        "  if (command.action === 'open') { const menu = electron.Menu.getApplicationMenu(); const item = menu?.items.find(item => item.label === 'Tools')?.submenu?.items.find(item => item.label === 'Usage'); if (!item) return; item.click() }",
        "  else if (command.action === 'close') usage().forEach(window => window.close())",
        "  else throw new Error('Unknown fixture action')",
        '  dispatched = command.id',
        ' }',
        ' switch (command.action) {',
        "  case 'open':",
        "   if (usage().length === 0 || usage().some(window => window.webContents.isLoadingMainFrame() || !window.webContents.getURL().includes('usage.html'))) return",
        '   break',
        "  case 'close':",
        '   if (usage().length > 0) return',
        '   break',
        "  default: throw new Error('Unknown fixture action')",
        ' }',
        ' last = command.id',
        " fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ id: last, windows: usage().map(window => ({ id: window.id, focuses: window.fixtureFocuses })) }))",
        '} catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) console.error(error) } }, 50).unref()',
        `require(${JSON.stringify(join(repo, 'app-client-ui/out/main/start.js'))})`,
      ].join('\n')
  }

  private static async pages(port: number): Promise<{ url: string; webSocketDebuggerUrl: string }[]> {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as { url: string; webSocketDebuggerUrl: string }[]
  }

  private static async connectUsage(port: number): Promise<WorkspaceCdp> {
    let url: string | undefined
    await RemoteUiScenarios.until(async () => { url = (await this.pages(port)).find(page => page.url.includes('usage.html'))?.webSocketDebuggerUrl; return !!url }, 'Usage renderer')
    const socket = new WebSocket(url!)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const client = new WorkspaceCdp(socket)
    await client.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    return client
  }
}
