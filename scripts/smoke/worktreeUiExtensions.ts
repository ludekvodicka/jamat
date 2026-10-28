import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths.js'
import { WorktreeResultsStore } from '../../lib-orchestrator/worktrees/worktreeResults.js'
import { ScriptLogStore } from '../../lib-orchestrator/sessionManager/worktreeSessionScripts.js'
import { RemoteUiScenarios, WorkspaceCdp } from './remoteUiScenarios.js'

export class WorktreeUiExtensions {
  static async run(parent: string): Promise<void> {
    const repo = join(import.meta.dirname, '..', '..')
    const root = await mkdtemp(join(parent, 'jamat-worktree-ui-'))
    const previousState = process.env.JAMAT_V3_LOCAL_STATE_DIR, previousHost = process.env.JAMAT_V3_HOST_STATE_DIR
    const held: { process: ChildProcess; closed: Promise<void> }[] = []
    let child: ChildProcess | undefined, ui: WorkspaceCdp | undefined, output = ''
    const run = async (command: string, cwd: string, args: string[]): Promise<string> => {
      const result = await new CommandInvoker().run({ command, cwd, args, env: process.env, timeoutMs: 60000 })
      assert.equal(result.failure, null, JSON.stringify(result)); assert.equal(result.code, 0, result.stderr || result.stdout)
      return result.stdout
    }
    try {
      const source = await RemoteUiScenarios.seed(root, 'extensions')
      const identity = ConfigIdentityStore.loadOrCreate(source.configDir, 'development').configIdentity
      process.env.JAMAT_V3_LOCAL_STATE_DIR = source.stateRoot
      const results = new WorktreeResultsStore(OrchestratorPaths.worktreeResultsDirectory(identity, 'development'), {
        now: Date.now, logs: new ScriptLogStore(join(root, 'historical-logs')), report: (message) => { throw new Error(message) },
      })
      await results.load()
      for (let index = 0; index < 50; index++) assert(await results.put({
        actionId: `history-${index}`, action: 'discard', result: 'discarded', sessionId: `history-${index}`,
        title: `Historical result ${index}`, tag: 'ui-extensions-history', worktreePath: join(root, `removed-${index}`),
        mainCopy: join(root, 'history-main'), directoryId: null, removal: 'removed', revisions: [], lines: [], logs: [],
        notify: null, at: Date.now(), acknowledgedAt: null,
      }))
      const entry = join(root, 'hidden-client.cjs')
      const { name, version } = JSON.parse(await readFile(join(repo, 'app-client-ui/package.json'), 'utf8'))
      await writeFile(join(root, 'package.json'), JSON.stringify({ name, version, main: 'hidden-client.cjs' }))
      await writeFile(entry, [
        "const electron = require('electron'), Module = require('node:module')",
        'const BrowserWindow = electron.BrowserWindow',
        'class HiddenWindow extends BrowserWindow {',
        '  constructor(options) { super({ ...options, show: false, focusable: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }) }',
        '  show() {}', '  showInactive() {}', '  focus() {}', '  restore() {}', '  maximize() {}', '}',
        'const isolated = Object.create(electron, { BrowserWindow: { value: HiddenWindow } }), load = Module._load',
        "Module._load = function(name, ...args) { return name === 'electron' ? isolated : load.call(this, name, ...args) }",
        'electron.Notification.prototype.show = () => {}',
        `electron.app.setAppPath(${JSON.stringify(join(repo, 'app-client-ui'))})`,
        `require(${JSON.stringify(join(repo, 'app-client-ui/out/main/start.js'))})`,
      ].join('\n'))
      const agents = join(root, 'agents')
      await mkdir(agents)
      const idle = JSON.parse(await readFile(join(repo, 'lib-orchestrator/sessionManager/workState/fixtures/claude-idle-prompt.json'), 'utf8'))
      await writeFile(join(agents, 'stand-in.cjs'), `const prompt=${JSON.stringify(`\x1b[2J\x1b[H${idle.frame.screenTail}\n`)}; process.stdout.write(prompt); setInterval(()=>process.stdout.write(prompt),1000)\n`)
      await writeFile(join(agents, 'claude.cmd'), `@"${process.execPath}" "%~dp0stand-in.cjs" %*\r\n`)
      const env: NodeJS.ProcessEnv = { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: source.stateRoot, JAMAT_V3_HOST_STATE_DIR: join(source.stateRoot, 'host'),
        JAMAT_V3_CONFIG_DIR: source.configDir, JAMAT_V3_RUNTIME_CHANNEL: 'development', JAMAT_V3_SKIP_SKILL_LINKS: '1',
        CLAUDE_CONFIG_DIR: source.configDir, CODEX_HOME: source.configDir }
      delete env.ELECTRON_RUN_AS_NODE
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      env[pathKey] = `${agents}${delimiter}${env[pathKey] ?? ''}`
      const start = async (): Promise<WorkspaceCdp> => {
        const debugPort = await RemoteUiScenarios.port()
        child = spawn(join(repo, 'app-client-ui/node_modules/electron/dist/electron.exe'), [root,
          `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true })
        child.stdout?.on('data', (bytes) => { output += bytes.toString() }); child.stderr?.on('data', (bytes) => { output += bytes.toString() })
        return WorkspaceCdp.connect(debugPort)
      }
      const stopClient = async (): Promise<void> => {
        ui?.close()
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill()
          await RemoteUiScenarios.until(async () => child!.exitCode !== null || child!.signalCode !== null, 'Owned extension client exited')
        }
      }
      ui = await start()
      const call = async (operation: string, body: object = {}): Promise<any> => {
        const result = await ui!.bridge<any>(`window.appClient.control.call(${JSON.stringify(operation)}, ${JSON.stringify(body)})`)
        assert(result.ok, JSON.stringify(result))
        return result.value
      }
      await RemoteUiScenarios.until(async () => (await call('host.status')).presence === 'running', 'Extension Host ready')
      const host = (await call('host.status')).descriptor
      assert.equal(host.configIdentity, identity)
      assert.equal((await call('sessions.worktreeResults', { tag: 'ui-extensions-history' })).results.length, 50)
      const click = async (selector: string, text: string): Promise<void> => {
        const expression = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.getBoundingClientRect().height > 0 && !e.disabled && (e.textContent.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)} || e.title === ${JSON.stringify(text)}))`
        await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`Boolean(${expression})`), `Extension button ${text}`)
        await ui!.evaluate(`(${expression}).click()`)
      }
      const open = async (id: string): Promise<void> => {
        await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`Boolean(document.querySelector('[data-session="${id}"] .jamat-sessions__row'))`), 'Created session reached the tree')
        await call('tabs.open', { session: { kind: 'sessionId', sessionId: id } })
      }
      const actions = async (id: string): Promise<void> => {
        await open(id)
        const point = await ui!.evaluate<{ x: number; y: number }>(`(() => { const e = document.querySelector('[data-session="${id}"] .jamat-sessions__row'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
        await ui!.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...point })
        await ui!.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...point })
        await click('.jamat-context-menu__item', 'Show session actions')
      }
      const finish = async (id: string): Promise<void> => {
        await open(id)
        const point = await ui!.evaluate<{ x: number; y: number }>(`(() => { const e = document.querySelector('[data-session="${id}"] .jamat-sessions__row'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
        await ui!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
        await click(`[data-session="${id}"] button`, 'Finish…')
      }
      const fixture = async (name: string, files: Record<string, string>) => {
        const directory = join(root, name), repository = join(directory, 'repository'), main = join(directory, 'main')
        await mkdir(directory)
        await run('svnadmin', directory, ['create', repository])
        await run('svn', directory, ['checkout', pathToFileURL(repository).href, main])
        for (const [path, text] of Object.entries(files)) await writeFile(join(main, path), text)
        await run('svn', main, ['add', ...Object.keys(files)])
        await run('svn', main, ['propset', 'svn:global-ignores', '.worktrees\n*.proof', '.'])
        await run('svn', main, ['commit', '-m', 'Seed disposable UI extension'])
        await run('svn', main, ['update'])
        return { directory, repository, main }
      }
      const create = async (main: string, title: string, deferSetupAgreement = false, kind: 'shell' | 'agent' = 'agent') => {
        const value = await call('sessions.create', { spec: { kind, directory: { mode: 'adHoc', path: main }, title,
          ...kind === 'agent' ? { agent: { agentId: 'claude', mode: 'new' } } : {},
          worktree: { slug: title.toLowerCase().replaceAll(' ', '-') }, ...deferSetupAgreement ? { deferSetupAgreement: true } : {} } })
        if (!deferSetupAgreement) await RemoteUiScenarios.until(async () => {
          const session = (await call('sessions.list')).sessions.find((row: any) => row.sessionId === value.session.sessionId)
          return session?.life === 'live' && (kind === 'shell' || session.activity === 'idle')
        }, `Started fixture session: ${title}`)
        return { id: value.session.sessionId as string, tree: value.session.worktree.worktreePath as string }
      }
      const visible = (text: string) => ui!.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`)
      const screenshot = async (name: string): Promise<void> => {
        await mkdir(join(repo, '.aidocs/screenshots'), { recursive: true })
        await ui!.capture(join(repo, `.aidocs/screenshots/worktree-extensions-${name}-1440x900.png`))
      }

      const setup = await fixture('setup', { '.worktree.json': JSON.stringify({ setup: ['node old.cjs'] }),
        'old.cjs': "require('node:fs').writeFileSync('old.proof', 'old')", 'new.cjs': "require('node:fs').writeFileSync('new.proof', 'new')" })
      const waiting = await create(setup.main, 'Setup agreement race', true, 'shell')
      await actions(waiting.id)
      await RemoteUiScenarios.until(async () => visible('node old.cjs'), 'Old commands are shown before consent')
      await writeFile(join(setup.main, '.worktree.json'), JSON.stringify({ setup: ['node new.cjs'] }))
      await run('svn', setup.main, ['commit', '-m', 'Change disposable setup while confirmation is visible'])
      await click('.session-actions button', 'Agree and run')
      await RemoteUiScenarios.until(async () => visible('node new.cjs'), 'Changed commands require new consent')
      for (const file of ['old.proof', 'new.proof']) await assert.rejects(access(join(waiting.tree, file)), 'No setup ran under stale consent')
      await screenshot('stale-setup')
      await click('.session-actions button', 'Agree and run')
      await RemoteUiScenarios.until(async () => readFile(join(waiting.tree, 'new.proof'), 'utf8').then((text) => text === 'new').catch(() => false), 'New setup runs after its own consent')
      await assert.rejects(access(join(waiting.tree, 'old.proof')), 'Old setup never ran')
      console.log('[worktree-ui-extensions] Setup changes during confirmation: stale consent runs nothing, new consent runs only the new command')

      const stress = await fixture('stress', Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`change-${String(index).padStart(3, '0')}.txt`, `base ${index}\n`])))
      const large = await create(stress.main, 'Large change review')
      await RemoteUiScenarios.until(async () => access(join(large.tree, 'change-499.txt')).then(() => true).catch(() => false), 'Large worktree checkout')
      for (let index = 0; index < 500; index++) await writeFile(join(large.tree, `change-${String(index).padStart(3, '0')}.txt`), `changed ${index}\n`)
      const startAt = Date.now()
      await finish(large.id)
      await click(`[data-session="${waiting.id}"] .jamat-sessions__title`, 'Setup agreement race')
      const switchedAt = Date.now()
      assert(switchedAt - startAt < 10000, 'Session switch remains responsive during preparation')
      await RemoteUiScenarios.until(async () => (await call('sessions.list')).sessions.find((row: any) => row.sessionId === large.id)?.worktreeView?.title === 'Ready for validation', 'Large review prepared')
      await click(`[data-session="${large.id}"] .jamat-sessions__title`, 'Large change review')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions__review input[type="checkbox"][aria-label^="Include change-"]')).length === 500`), 'All 500 review entries rendered')
      await click('.session-actions__review button', 'Select none')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions__review input[aria-label^="Include change-"]')).filter(e => e.checked).length === 0`), 'All 500 paths deselected')
      await click('.session-actions__review button', 'Select all')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions__review input[aria-label^="Include change-"]')).filter(e => e.checked).length === 500`), 'All 500 paths selected')
      const frameMs = await ui.evaluate<number>('new Promise(resolve => { const start=performance.now(); requestAnimationFrame(() => resolve(performance.now()-start)) })')
      assert(frameMs < 2000, `Large review frame stalled for ${frameMs} ms`)
      assert.equal((await call('sessions.worktreeResults', { tag: 'ui-extensions-history' })).results.length, 50)
      await screenshot('500-changes')
      console.log(`[worktree-ui-extensions] 500 rendered changes with 50 persisted results: switch ${switchedAt - startAt} ms, review ${Date.now() - startAt} ms, frame ${frameMs.toFixed(1)} ms; none/all 0/500`)

      const outer = await fixture('locks', { 'app.txt': 'base\n' })
      for (const name of ['EA', 'EB']) {
        const library = await fixture(name, { 'limit.txt': '10\n' })
        await run('svn', outer.main, ['propset', 'svn:externals', ['EA', 'EB'].filter((value) => value === 'EA' || name === 'EB')
          .map((value) => `${pathToFileURL(join(root, value, 'repository')).href} ${value}`).join('\n'), '.'])
        assert(await access(library.main).then(() => true))
      }
      await run('svn', outer.main, ['commit', '-m', 'Add two disposable external roots'])
      await run('svn', outer.main, ['update'])
      const locked = await create(outer.main, 'Independent locked roots')
      await RemoteUiScenarios.until(async () => access(join(locked.tree, 'EB/limit.txt')).then(() => true).catch(() => false), 'Two external roots checked out')
      for (const name of ['EA', 'EB']) {
        await writeFile(join(locked.tree, name, 'limit.txt'), '20\n')
        await writeFile(join(root, name, 'main/limit.txt'), '30\n')
        await run('svn', join(root, name, 'main'), ['commit', '-m', 'Incoming external conflict'])
        await run('svn', join(locked.tree, name), ['update', '--ignore-externals', '--accept', 'postpone'])
      }
      await finish(locked.id)
      await click('.session-actions button', 'Check again')
      await click('.session-actions button', 'Show details: Check the conflicts')
      const conflict = (path: string) => `Array.from(document.querySelectorAll('li.workflow__conflict')).find(e => e.querySelector('.workflow__conflict-path')?.textContent.trim() === ${JSON.stringify(path)})`
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`Boolean(${conflict('EA/limit.txt')}) && Boolean(${conflict('EB/limit.txt')})`), 'Both external conflicts visible')
      const choose = async (path: string, label: string): Promise<void> => {
        await ui!.evaluate(`(() => { const row=${conflict(path)}; const button=Array.from(row.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled); if(!button)throw new Error('No conflict choice'); button.click() })()`)
      }
      const holders = new Map<string, { process: ChildProcess; closed: Promise<void> }>()
      for (const name of ['EA', 'EB']) {
        const process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$f=[System.IO.File]::Open($env:JAMAT_V3_HELD_FILE,'Open','Read','Read'); try { [Console]::WriteLine('HELD'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }"],
        { windowsHide: true, env: { ...env, JAMAT_V3_HELD_FILE: join(locked.tree, name, 'limit.txt.mine') }, stdio: ['pipe', 'pipe', 'pipe'] })
        const holder = { process, closed: new Promise<void>((resolve) => process.once('close', () => resolve())) }
        held.push(holder); holders.set(name, holder)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Extension holder did not become ready')), 10000)
          process.once('error', (error) => { clearTimeout(timer); reject(error) })
          process.stdout!.on('data', (bytes) => { if (String(bytes).includes('HELD')) { clearTimeout(timer); resolve() } })
        })
        await choose(`${name}/limit.txt`, 'Take incoming')
        await choose(`${name}/limit.txt`, 'Take incoming?')
        await RemoteUiScenarios.until(async () => (await run('svn', join(locked.tree, name), ['status', '--xml'])).includes('wc-locked="true"'), `${name} native write queue remains locked`)
        await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`(${conflict(`${name}/limit.txt`)})?.innerText.includes('Settle failed:')`), `${name} settlement returned its held-file result`)
      }
      await writeFile(join(locked.tree, 'EA/limit.txt'), '25\n')
      holders.get('EA')!.process.stdin!.end('\n'); await holders.get('EA')!.closed
      await click('.session-actions button', 'Check again')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`(${conflict('EA/limit.txt')})?.dataset.state === 'settled' && (${conflict('EB/limit.txt')})?.dataset.state !== 'settled'`), 'First root settles independently')
      assert.equal(await readFile(join(locked.tree, 'EA/limit.txt'), 'utf8'), '25\n')
      await screenshot('one-root-held')
      await stopClient(); ui = await start()
      await RemoteUiScenarios.until(async () => Boolean((await call('host.status')).lease.leaseId), 'Restarted client holds the Host controller lease')
      assert.equal((await call('host.status')).descriptor.hostInstanceId, host.hostInstanceId, 'Client restart preserves the exact Host')
      await actions(locked.id)
      if (!await ui.evaluate<boolean>(`Boolean(${conflict('EB/limit.txt')})`)) await click('.session-actions button', 'Show details: Check the conflicts')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`Boolean(${conflict('EB/limit.txt')})`), 'Conflict panel restored after client restart')
      assert.equal(await readFile(join(locked.tree, 'EA/limit.txt'), 'utf8'), '25\n')
      await writeFile(join(locked.tree, 'EB/limit.txt'), '35\n')
      holders.get('EB')!.process.stdin!.end('\n'); await holders.get('EB')!.closed
      await click('.session-actions button', 'Check again')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`(${conflict('EA/limit.txt')})?.dataset.state === 'settled' && (${conflict('EB/limit.txt')})?.dataset.state === 'settled'`), 'Both roots settled after restart')
      for (const [name, expected] of [['EA', '25\n'], ['EB', '35\n']]) {
        assert.equal(await readFile(join(locked.tree, name, 'limit.txt'), 'utf8'), expected)
        const status = await run('svn', join(locked.tree, name), ['status', '--xml'])
        assert(!status.includes('wc-locked="true"') && !status.includes('item="conflicted"'), status)
      }
      await screenshot('two-roots-recovered')
      console.log('[worktree-ui-extensions] Two locked external roots: manual edits survive independent recoveries and a client restart; exact Host unchanged')
      console.log('[worktree-ui-extensions] All three additional UI scenarios passed')
    } catch (error) {
      output += `\n${String(error)}\n${await ui?.evaluate('document.body.innerText').catch(String)}`
      throw error
    } finally {
      let cleanupError: unknown
      for (const holder of held) {
        if (holder.process.exitCode === null && holder.process.signalCode === null) holder.process.stdin?.end('\n')
        await holder.closed
      }
      if (ui) {
        try {
          const status = (await ui.bridge<any>("window.appClient.control.call('host.status', {})")).value
          if (status.presence === 'running') {
            await RemoteUiScenarios.until(async () => Boolean((await ui!.bridge<any>("window.appClient.control.call('host.status', {})")).value.lease.leaseId), 'Cleanup client holds its Host lease')
            const stopped = await ui.bridge<any>(`window.appClient.control.call('host.stop', {expectedHostInstanceId:${JSON.stringify(status.descriptor.hostInstanceId)}})`)
            assert(stopped.ok, JSON.stringify(stopped))
          }
        } catch (error) { cleanupError = error; output += `\nHost cleanup: ${String(error)}` }
        ui.close()
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await RemoteUiScenarios.until(async () => child!.exitCode !== null || child!.signalCode !== null, 'Extension client stopped')
      }
      await mkdir(join(repo, '.aidocs/temp'), { recursive: true })
      await writeFile(join(repo, '.aidocs/temp/worktree-ui-extensions.log'), output)
      if (previousState === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
      else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousState
      if (previousHost === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
      else process.env.JAMAT_V3_HOST_STATE_DIR = previousHost
      if (cleanupError) throw new Error(`Extension Host cleanup failed; fixture retained at ${root}`, { cause: cleanupError })
      const inside = relative(parent, root)
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside))
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}
