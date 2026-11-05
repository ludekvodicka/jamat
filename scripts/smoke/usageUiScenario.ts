import { TerminalDescendants } from '../../app-host/app/terminal/terminalDescendants.js'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
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
      const open = async (id: number): Promise<{ id: number; windows: number }> => {
        await writeFile(join(root, 'command.json'), JSON.stringify({ id }))
        let result: { id: number; windows: number } | null = null
        await RemoteUiScenarios.until(async () => {
          try { result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')); return result?.id === id } catch { return false }
        }, `Usage menu command ${id}`)
        return result as unknown as { id: number; windows: number }
      }
      const ui = clients[0]
      await open(1)
      await open(2)
      let seen = { tabs: 0, cards: 0, charts: 0, text: '' }
      await RemoteUiScenarios.until(async () => {
        seen = JSON.parse(await ui.evaluate<string>('JSON.stringify({ tabs: document.querySelectorAll(".jamat-usage").length, cards: document.querySelectorAll(".jamat-usage__quotas > .jamat-usage__card").length, charts: document.querySelectorAll(".jamat-usage__graph svg").length, text: (document.querySelector(".jamat-usage")?.innerText ?? "").slice(0, 600) })'))
        return seen.tabs === 1 && seen.cards === 2 && seen.charts >= 4
      }, 'One Usage tab with quota cards and four Vega charts').catch((error: unknown) => { throw new Error(`${String(error)}; last seen ${JSON.stringify(seen)}`) })
      assert((await ui.evaluate<string>('document.body.innerText')).includes('155 of 200%'))
      assert((await ui.evaluate<string>('document.body.innerText')).includes('JamatProof'))
      assert.equal((await open(3)).windows, 1)
      await ui.capture(join(screenshotRoot, 'phase3-usage-overview-1440x900.png'))
      await ui.evaluate('document.querySelector(".jamat-usage__tokens").scrollIntoView()')
      await ui.capture(join(screenshotRoot, 'phase3-usage-tokens-1440x900.png'))
      const tokens = await ui.bridge<any>(`window.appClient.control.call('usage.tokens', { from: '${new Date(now - 6 * 86_400_000).toISOString().slice(0, 10)}', to: '${new Date(now + 86_400_000).toISOString().slice(0, 10)}', groupBy: 'project' })`)
      assert.equal(tokens.value.rows.length, 2)
      assert.equal(tokens.value.rows.find((row: { agentId: string }) => row.agentId === 'codex').input, 2000)
      console.log('[smoke:ui] Tools > Usage opens one workspace tab however often it is chosen; account pools, reset projection and both agents token totals render')
    } catch (error) {
      console.error(log)
      throw error
    } finally {
      for (const client of clients) client.close()
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await RemoteUiScenarios.until(async () => child!.exitCode !== null || child!.signalCode !== null, 'Usage client stopped')
      }
      // A utility that has not started its fixture wrapper yet must refuse to start the app.
      await writeFile(join(root, 'cleanup-started'), '')
      let utilityIntent = false
      try { await readFile(join(root, 'utility-intent')); utilityIntent = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (utilityIntent) {
        const utility: { value: { pid: number; startedAt: number } | null } = { value: null }
        await RemoteUiScenarios.until(async () => {
          try { utility.value = JSON.parse(await readFile(join(root, 'utility-birth.json'), 'utf8')); return true }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
        }, 'Usage orchestration utility birth receipt, including early startup failure', 15_000)
        assert(utility.value && Number.isSafeInteger(utility.value.pid) && utility.value.pid > 0 && Number.isSafeInteger(utility.value.startedAt))
        await TerminalDescendants.stop([utility.value])
      }
      // A detached Host can publish its descriptor after an early client failure. Its spawn receipt
      // exists synchronously, before the child can outlive the fixture's cleanup.
      let hostPids: number[] = []
      try { hostPids = JSON.parse(await readFile(join(root, 'host-pids.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const hosts = []
      for (const hostPid of hostPids) {
        if (!Number.isInteger(hostPid) || hostPid <= 0) throw new Error('Invalid Usage fixture Host spawn receipt')
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '(Get-CimInstance Win32_Process -Filter "ProcessId=' + hostPid + '") | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; command=$_.CommandLine; startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress'],
        { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
        assert.equal(result.status, 0, result.stderr)
        if (!result.stdout.trim()) continue
        const host = JSON.parse(result.stdout)
        // The receipt is written synchronously in the owning utility, including early startup failures.
        // Recheck the private config in the command line before capturing the birth used for termination.
        if (!host.command?.toLowerCase().includes(config.toLowerCase())) continue
        assert(Number.isSafeInteger(host.startedAt) && host.startedAt >= (await lstat(root)).birthtimeMs - 1000)
        hosts.push({ pid: hostPid, startedAt: host.startedAt })
      }
      await TerminalDescendants.stop(hosts)
      console.log('[smoke:ui] Usage private Hosts stopped with verified process births: ' + JSON.stringify(hosts))
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
        ' constructor(options) { super({ ...options, show: false, focusable: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true } }) }',
        ' show() {} focus() {} restore() {} maximize() {}',
        '}',
        "const isolated = Object.create(electron, { BrowserWindow: { value: HiddenWindow } }), load = Module._load",
        "Module._load = function(name, ...args) { return name === 'electron' ? isolated : load.call(this, name, ...args) }",
        'const fork = electron.utilityProcess.fork',
        "Object.defineProperty(isolated, 'utilityProcess', { value: { ...electron.utilityProcess, fork: function(bundle, args, options) {",
        " if (options?.serviceName !== 'Jamat orchestrator') return fork.call(electron.utilityProcess, bundle, args, options)",
        " const wrapper = path.join(__dirname, 'orchestrator-fixture.cjs')",
        " fs.writeFileSync(path.join(__dirname, 'utility-intent'), '')",
        ' fs.writeFileSync(wrapper, (function ' + UsageUiScenario.hostFixtureSource.toString() + ')(bundle, __dirname))',
        ' return fork.call(electron.utilityProcess, wrapper, args, options)',
        '} } })',
        'electron.Notification.prototype.show = () => {}',
        `electron.app.setAppPath(${JSON.stringify(join(repo, 'app-client-ui'))})`,
        'let last = 0',
        'setInterval(() => { try {',
        " const command = JSON.parse(fs.readFileSync(path.join(__dirname, 'command.json'), 'utf8'))",
        ' if (command.id === last) return',
        " const item = electron.Menu.getApplicationMenu()?.items.find(item => item.label === 'Tools')?.submenu?.items.find(item => item.label === 'Usage')",
        ' if (!item) return',
        ' item.click()',
        ' last = command.id',
        " fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ id: last, windows: electron.BaseWindow.getAllWindows().length }))",
        '} catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) console.error(error) } }, 50).unref()',
        `require(${JSON.stringify(join(repo, 'app-client-ui/out/main/start.js'))})`,
      ].join('\n')
  }

  static hostFixtureSource(bundle: string, root: string): string {
    return [
      "const children = require('node:child_process'), fs = require('node:fs'), path = require('node:path')",
      'const root = ' + JSON.stringify(root) + ', spawn = children.spawn, hostPids = []',
      "const born = children.spawnSync(\"powershell.exe\", [\"-NoProfile\", \"-NonInteractive\", \"-Command\", \"(Get-CimInstance Win32_Process -Filter 'ProcessId=\" + process.pid + \"').CreationDate | ForEach-Object { ([DateTimeOffset]$_).ToUnixTimeMilliseconds() }\"], { windowsHide: true, encoding: \"utf8\", timeout: 10000 })",
      'const startedAt = Number(born.stdout.trim())',
      'if (born.status !== 0 || !Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error("Usage utility birth query failed")',
      'fs.writeFileSync(path.join(root, "utility-birth.json"), JSON.stringify({ pid: process.pid, startedAt }))',
      'if (fs.existsSync(path.join(root, "cleanup-started"))) process.exit(0)',
      'children.spawn = function(command, args, options) {',
      ' const child = spawn.call(this, command, args, options)',
      " if (options?.detached && options.env?.JAMAT_V3_HOST_STATE_DIR === path.join(root, 'state/host') && args?.includes(path.join(root, 'config')) && child.pid) {",
      "  hostPids.push(child.pid); fs.writeFileSync(path.join(root, 'host-pids.json'), JSON.stringify(hostPids))",
      ' }',
      ' return child',
      '}',
      'require(' + JSON.stringify(bundle) + ')',
    ].join('\n')
  }
}
