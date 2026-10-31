import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { RemoteUiScenarios, WorkspaceCdp } from './remoteUiScenarios.js'

export class FinishUiScenario {
  static async run(parent = tmpdir(), realAgent = false, externals = false): Promise<void> {
    const repo = join(import.meta.dirname, '..', '..'), electron = join(repo, 'app-client-ui/node_modules/electron/dist/electron.exe')
    await access(electron).catch(() => { throw new Error(`Electron is not installed in app-client-ui: ${electron}`) })
    const root = await mkdtemp(join(parent, 'jamat-finish-ui-'))
    const owner = join(root, 'main'), tag = `pp-u50-${Date.now()}`, screenshotRoot = join(repo, '.aidocs/screenshots')
    const capture = (client: WorkspaceCdp, name: string) => client.capture(join(screenshotRoot,
      `worktree-finish-${externals ? 'externals-' : ''}${name}-1440x900.png`))
    const previousState = process.env.JAMAT_V3_LOCAL_STATE_DIR, previousHost = process.env.JAMAT_V3_HOST_STATE_DIR
    const children: ChildProcess[] = [], clients: WorkspaceCdp[] = [], hosts: string[] = [], logs: { label: string; text: string }[] = []
    const hostPids = new Set<number>()
    let remoteReference: { endpoint: string; viewId: string } | undefined
    let env: NodeJS.ProcessEnv = { ...process.env }
    const run = async (command: string, cwd: string, args: string[]): Promise<string> => {
      const result = await new CommandInvoker().run({ command, cwd, args, env, timeoutMs: 60000 })
      assert.equal(result.failure, null, JSON.stringify(result)); assert.equal(result.code, 0, result.stderr || result.stdout)
      return result.stdout
    }
    try {
      await mkdir(screenshotRoot, { recursive: true })
      const source = await RemoteUiScenarios.seed(root, `${tag}-source`), controller = await RemoteUiScenarios.seed(root, `${tag}-controller`)
      hosts.push(source.hostFile, controller.hostFile)
      RemoteUiScenarios.pair(source, controller)
      const { configDir, stateRoot } = source
      env = { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: stateRoot, JAMAT_V3_HOST_STATE_DIR: join(stateRoot, 'host'),
        JAMAT_V3_CONFIG_DIR: configDir, JAMAT_V3_RUNTIME_CHANNEL: 'development', JAMAT_V3_SKIP_SKILL_LINKS: '1', CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: configDir }
      if (realAgent) {
        if (process.env.CLAUDE_CONFIG_DIR === undefined) delete env.CLAUDE_CONFIG_DIR
        else env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
      }
      delete env.ELECTRON_RUN_AS_NODE
      process.env.JAMAT_V3_LOCAL_STATE_DIR = stateRoot
      process.env.JAMAT_V3_HOST_STATE_DIR = join(stateRoot, 'host')
      const { configIdentity } = ConfigIdentityStore.loadOrCreate(configDir, 'development')
      const repository = join(root, 'repository')
      const library = join(root, 'library'), addedLibrary = join(root, 'added-library')
      if (externals) {
        for (const target of [library, addedLibrary]) {
          await run('svnadmin', root, ['create', target])
          const seed = `${target}-seed`
          await mkdir(seed)
          await writeFile(join(seed, 'lib.cjs'), 'module.exports = 1\n')
          const message = `${target}-message.txt`; await writeFile(message, 'Seed disposable external')
          await run('svn', root, ['import', seed, pathToFileURL(target).href, '--file', message, '--username', 'fixture'])
        }
      }
      await run('svnadmin', root, ['create', repository])
      await run('svn', root, ['checkout', pathToFileURL(repository).href, owner])
      await writeFile(join(owner, 'worker.txt'), 'base\n')
      await writeFile(join(owner, 'validate.cjs'), "require('node:fs').writeFileSync('validation-proof.json', JSON.stringify({cwd:process.cwd(),pid:process.pid})); console.log('VALIDATION_READY'); setInterval(()=>{},1000)\n")
      await run('svn', owner, ['add', 'worker.txt', 'validate.cjs'])
      if (externals) {
        await writeFile(join(owner, 'clean.txt'), 'clean base\n')
        await writeFile(join(owner, 'Title.txt'), 'case move\n')
        await mkdir(join(owner, 'carrier'))
        await run('svn', owner, ['add', 'clean.txt', 'Title.txt', 'carrier'])
        await run('svn', owner, ['propset', 'svn:externals', `${pathToFileURL(library).href} shared/library`, '.'])
      }
      await run('svn', owner, ['propset', 'svn:global-ignores', '.worktrees\nvalidation-proof.json', '.'])
      const seed = join(root, 'seed.txt'); await writeFile(seed, 'Seed disposable Finish UI fixture')
      await run('svn', owner, ['commit', '--file', seed, '--username', 'fixture'])
      await run('svn', owner, ['update'])
      const agents = join(root, 'agents'), worker = join(agents, 'stand-in-claude.cjs'), workerProof = join(root, 'worker-proof.json')
      const prompt = realAgent
        ? 'This is an authorized disposable Jamat worktree acceptance fixture. Only do these edits in the current working directory: write worker.txt with exactly scripted worker change followed by LF; create new-dir/nested/file.txt with exactly reviewed nested file followed by LF. Do not commit, create checkpoints, write documentation or edit any other path. Reply FIXTURE_READY when done and wait. The test controller will prepare and publish through the UI.'
        : 'Background checkout acceptance. Keep this complete prompt and start once.'
      await mkdir(agents)
      const idle = JSON.parse(await readFile(join(repo, 'lib-orchestrator/sessionManager/workState/fixtures/claude-idle-prompt.json'), 'utf8'))
      await writeFile(worker, [
        "const assert = require('node:assert/strict')",
        "const { mkdirSync, writeFileSync } = require('node:fs')",
        "const { resolve, sep } = require('node:path')",
        `assert(process.cwd().toLowerCase().startsWith((resolve(${JSON.stringify(owner)}, '.worktrees') + sep).toLowerCase()))`,
        "const nativeSessionId = process.argv[process.argv.indexOf('--session-id') + 1]",
        "assert.match(nativeSessionId, /^[0-9a-f-]{36}$/i)",
        `assert(process.argv.includes(${JSON.stringify(prompt)}), 'complete initial prompt reached the background worker')`,
        `writeFileSync(${JSON.stringify(workerProof)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), nativeSessionId }))`,
        `writeFileSync('worker.txt', ${JSON.stringify('scripted worker change\n')})`,
        "mkdirSync('new-dir/nested', { recursive: true })",
        "writeFileSync('new-dir/nested/file.txt', 'reviewed nested file\\n')",
        `const prompt = ${JSON.stringify(`\x1b[2J\x1b[H${idle.frame.screenTail}\n`)}`,
        'process.stdout.write(prompt)',
        'setInterval(() => process.stdout.write(prompt), 1000)',
        '',
      ].join('\n'))
      await run(process.execPath, root, ['--check', worker])
      await writeFile(join(agents, 'claude.cmd'), `@"${process.execPath}" "%~dp0stand-in-claude.cjs" %*\r\n`)
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      if (!realAgent) env[pathKey] = `${agents}${delimiter}${env[pathKey] ?? ''}`
      const entry = join(root, 'hidden-client.cjs')
      const { name, version } = JSON.parse(await readFile(join(repo, 'app-client-ui/package.json'), 'utf8'))
      await writeFile(join(root, 'package.json'), JSON.stringify({ name, version, main: 'hidden-client.cjs' }))
      await writeFile(entry, [
        "process.on('uncaughtException', error => { console.error(error); process.exit(1) })",
        "const assert = require('node:assert/strict')",
        "const electron = require('electron')",
        "const Module = require('node:module')",
        'const BrowserWindow = electron.BrowserWindow',
        'class HiddenWindow extends BrowserWindow {',
        '  constructor(options) { super({ ...options, show: false, focusable: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }) }',
        '  show() {}',
        '  showInactive() {}',
        '  focus() {}',
        '  restore() {}',
        '  maximize() {}',
        '}',
        "const isolatedElectron = Object.create(electron, { BrowserWindow: { value: HiddenWindow } })",
        'const load = Module._load',
        "Module._load = function(name, ...args) { return name === 'electron' ? isolatedElectron : load.call(this, name, ...args) }",
        'electron.Notification.prototype.show = () => {}',
        `electron.app.setAppPath(${JSON.stringify(join(repo, 'app-client-ui'))})`,
        "setInterval(() => { for (const window of BrowserWindow.getAllWindows()) { assert(!window.isVisible(), 'Fixture window must stay hidden'); assert(!window.isFocused(), 'Fixture window must not take desktop focus') } }, 100).unref()",
        `require(${JSON.stringify(join(repo, 'app-client-ui/out/main/start.js'))})`,
      ].join('\n'))
      for (const [label, side] of [['source', source], ['remote', controller]] as const) {
        const childEnv = { ...env, JAMAT_V3_LOCAL_STATE_DIR: side.stateRoot, JAMAT_V3_HOST_STATE_DIR: join(side.stateRoot, 'host'),
          JAMAT_V3_CONFIG_DIR: side.configDir, ...realAgent ? {} : { CLAUDE_CONFIG_DIR: side.configDir }, CODEX_HOME: side.configDir }
        const child = spawn(electron, [root,
          `--remote-debugging-port=${side.debugPort}`, '--remote-debugging-address=127.0.0.1'], { env: childEnv, windowsHide: true })
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        children.push(child)
        const log = { label, text: '' }; logs.push(log)
        child.stdout?.on('data', (bytes) => { log.text += bytes.toString() }); child.stderr?.on('data', (bytes) => { log.text += bytes.toString() })
        clients.push(await WorkspaceCdp.connect(side.debugPort))
      }
      const ui = clients[0]!, remote = clients[1]!, endpoint = source.identity.remoteEndpointId
      for (const [index, client] of clients.entries()) {
        await RemoteUiScenarios.until(async () => (await client.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.host.presence === 'running', 'Private fixture Host ready')
        const status = (await client.bridge<any>(`window.appClient.control.call('host.status', {})`)).value
        const descriptor = JSON.parse(await readFile(hosts[index]!, 'utf8'))
        assert.equal(status.descriptor.hostInstanceId, descriptor.hostInstanceId)
        hostPids.add(descriptor.pid)
      }
      const cli = async (args: string[]) => JSON.parse(await run(process.execPath, repo,
        ['--import', 'tsx', join(repo, 'app-client-cli/start.ts'), ...args, '--config-dir', configDir, '--channel', 'development']))
      if (realAgent) {
        const settings = await ui.bridge<any>(`window.appClient.control.call('agentSettings.save', { value: { claude: { yolo: true }, codex: { yolo: false } } })`)
        assert(settings.ok, JSON.stringify(settings))
      }
      const created = await cli(['sessions', 'create', '--agent', 'claude', '--mode', 'new', '--directory', owner,
        '--worktree', 'finish-ui', '--worktree-tag', tag, '--title', `${tag} Finish UI worker`, '--prompt', prompt])
      assert(created.ok, JSON.stringify(created))
      const id = created.value.session.sessionId
      let live: any, runtime: any
      await RemoteUiScenarios.until(async () => {
        live = (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.sessions.find((row: any) => row.sessionId === id)
        const status = (await ui.bridge<any>(`window.appClient.control.call('host.status', {})`)).value
        runtime = status.runtimes.find((row: any) => row.sessionTitle === live?.title && !row.orphan && row.alive)
        const editsReady = !realAgent || live?.worktree && await readFile(join(live.worktree.worktreePath, 'new-dir/nested/file.txt'), 'utf8').then((text) => text === 'reviewed nested file\n').catch(() => false)
        return editsReady && live?.life === 'live' && live.agent?.nativeSessionId && live.activity === 'idle'
          && runtime?.work?.hint === 'idle' && status.poll.lastTickAt !== null && Date.now() - status.poll.lastTickAt < 10000
      }, 'Host-managed worker has a live binding and fresh recognized idle prompt', realAgent ? 180000 : 60000)
      const proof = realAgent ? { pid: runtime.pid, cwd: live.worktree.worktreePath, nativeSessionId: live.agent.nativeSessionId }
        : JSON.parse(await readFile(workerProof, 'utf8')), title = live.title
      assert.equal(live.agent.nativeSessionId, proof.nativeSessionId)
      assert.equal(await readFile(join(proof.cwd, 'worker.txt'), 'utf8'), 'scripted worker change\n')
      if (externals) {
        await writeFile(join(proof.cwd, 'shared/library/lib.cjs'), 'module.exports = 2\n')
        await run('svn', proof.cwd, ['move', 'Title.txt', 'case-temp.txt'])
        await run('svn', proof.cwd, ['move', 'case-temp.txt', 'title.txt'])
        await run('svn', proof.cwd, ['propset', 'svn:externals', `${pathToFileURL(addedLibrary).href} added`, 'carrier'])
      }
      const scripts = await cli(['sessions', 'scripts', '--session-id', id])
      assert.ok(scripts.ok, JSON.stringify(scripts))
      const checkout = scripts.value.runs.find((run: any) => run.scriptId === 'svn' && run.name === 'Checkout')
      assert.ok(checkout, JSON.stringify(scripts))
      assert.equal(checkout.state, 'succeeded')
      assert.equal(checkout.exitCode, 0)
      assert.ok(typeof checkout.startedAt === 'number' && typeof checkout.endedAt === 'number' && checkout.endedAt >= checkout.startedAt)
      const checkoutLog = await cli(['sessions', 'scripts', '--session-id', id, '--run-id', checkout.runId])
      assert.ok(checkoutLog.ok && checkoutLog.value.log.text.includes('Checked out revision'), JSON.stringify(checkoutLog))
      console.log('[smoke:ui] background CLI create retains checkout timestamps, exit 0 and log; full prompt starts one worker without an open tab')
      console.log(`[smoke:ui] live Host runtime ${runtime.runtimeSessionId}, ${realAgent ? 'native Claude' : 'stand-in'} PID ${proof.pid}, native launch ID ${proof.nativeSessionId}: fresh idle prompt recognized`)
      env.JAMAT_V3_SESSION_ID = id
      env.JAMAT_V3_SESSION_CONTROLLER = configIdentity
      env.JAMAT_V3_SESSION_CHANNEL = 'development'
      const proposal = join(root, 'proposal.txt'); await writeFile(proposal, '[repository] **Apply scripted worker change**')
      await run(process.execPath, repo, ['--import', 'tsx', join(repo, 'app-client-cli/start.ts'), 'commit', 'propose', '--self',
        '--message-file', proposal])
      await ui.bridge(`window.appClient.control.call('tabs.open', { session: { kind: 'sessionId', sessionId: ${JSON.stringify(id)} } })`)
      const click = async (client: WorkspaceCdp, selector: string, text: string): Promise<void> => {
        const match = `e.getBoundingClientRect().height > 0 && !e.disabled && (e.querySelector('.workflow__step-title')?.textContent.trim() === ${JSON.stringify(text)} || e.textContent.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)} || e.title === ${JSON.stringify(text)})`
        await RemoteUiScenarios.until(async () => client.evaluate<boolean>(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e => ${match})`), `Button ${text}`)
        await client.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => ${match}).click()`)
      }
      const reviewVisible = `!!Array.from(document.querySelectorAll('.session-actions__review')).find(e => !e.hidden && e.getBoundingClientRect().height > 0)`
      const commitEnabled = `Array.from(document.querySelectorAll('.session-actions__review button')).some(e => e.textContent === 'Publish verified changes' && !e.disabled && e.getBoundingClientRect().height > 0)`
      const messageIs = (text: string): string => `Array.from(document.querySelectorAll('.session-actions__review textarea')).some(e => e.value === ${JSON.stringify(text)})`
      const message = async (client: WorkspaceCdp, text: string, repositoryName = 'repository', mount = '.'): Promise<void> => {
        const selector = externals ? `.session-actions__review textarea[aria-label="Commit message ${repositoryName} (${mount})"]`
          : '.session-actions__review .commit-message textarea'
        await RemoteUiScenarios.until(async () => client.evaluate<boolean>(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e => !e.disabled && e.getBoundingClientRect().height > 0)`), `Ready message editor: ${repositoryName}`)
        await client.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.getBoundingClientRect().height > 0).focus()`)
        await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
        await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
        await client.call('Input.insertText', { text })
      }
      const row = await ui.evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector('[data-session="${id}"] .jamat-sessions__row').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`)
      await ui.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...row })
      await click(ui, `[data-session="${id}"] button`, 'Finish…')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(reviewVisible), 'Source automatically opened synced review')
      const firstView = (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.sessions.find((row: any) => row.sessionId === id).worktreeView
      console.log(`[smoke:ui] DOM Finish opened the initial synced source review at lifecycle version ${firstView?.version}`)
      const connected = await remote.bridge<any>(`window.appClient.remote.connect('network-settings', ${JSON.stringify(endpoint)})`)
      assert(connected.ok, JSON.stringify(connected))
      const selected = await remote.bridge<any>(`window.appClient.remote.selectSession(${JSON.stringify(endpoint)}, ${JSON.stringify(id)})`)
      assert(selected.ok, JSON.stringify(selected))
      await RemoteUiScenarios.until(async () => remote.evaluate<boolean>(`Array.from(document.querySelectorAll('.jamat-sessions__title')).some(e => e.textContent === ${JSON.stringify(title)})`), 'Paired source session')
      await remote.evaluate(`Array.from(document.querySelectorAll('.jamat-sessions__title')).find(e => e.textContent === ${JSON.stringify(title)}).click()`)
      for (const client of clients) {
        await RemoteUiScenarios.until(async () => client.evaluate<boolean>(reviewVisible), 'First automatically opened synced review')
        await RemoteUiScenarios.until(async () => client.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions__review .commit-target input')).some(e => e.getAttribute('aria-label') === 'Include worker.txt' && e.getBoundingClientRect().height > 0)`), 'Loaded source-owned review rows')
        assert(!(await client.evaluate<string>('document.body.innerText')).includes('This review is outdated'), 'First automatic review must bind its displayed version')
        await RemoteUiScenarios.until(async () => client.evaluate<boolean>(messageIs('[repository] **Apply scripted worker change**')), 'Root proposal is visible before any person edits')
        if (externals) assert.equal(await client.evaluate(`document.querySelector('textarea[aria-label="Commit message library (shared/library)"]').value.trim()`), '[library]', 'Root proposal must not populate an external message')
      }
      if (externals) {
        assert.equal(await readFile(join(proof.cwd, 'carrier/added/lib.cjs'), 'utf8'), 'module.exports = 1\n')
        await message(ui, '[library] Publish reviewed external change', 'library', 'shared/library')
        await RemoteUiScenarios.until(async () => remote.evaluate<boolean>(messageIs('[library] Publish reviewed external change')), 'External message reaches the paired review')
      }
      const sourceView = (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.sessions.find((row: any) => row.sessionId === id).worktreeView
      const opened = await remote.bridge<any>(`window.appClient.remote.openView(${JSON.stringify(endpoint)}, ${JSON.stringify(id)})`)
      assert(opened.ok, JSON.stringify(opened))
      remoteReference = { endpoint, viewId: opened.value.viewId }
      let remoteView: typeof sourceView
      await RemoteUiScenarios.until(async () => {
        const detail = await remote.bridge<any>(`window.appClient.remote.readView(${JSON.stringify(endpoint)}, ${JSON.stringify(opened.value.viewId)})`)
        assert(detail.ok, JSON.stringify(detail))
        remoteView = detail.value.session.worktreeView
        return remoteView?.version === sourceView.version
      }, 'Source and paired remote waiting view parity')
      assert.deepEqual({ title: remoteView.title, tone: remoteView.tone, actions: remoteView.actions },
        { title: sourceView.title, tone: sourceView.tone, actions: sourceView.actions })
      assert.equal(sourceView.title, 'Ready for validation'); assert.equal(sourceView.tone, 'wait')
      const presentation = `(() => { const pane = Array.from(document.querySelectorAll('.session-actions__review')).find(e => e.getBoundingClientRect().height > 0); return { title: pane.querySelector('h2').textContent, summary: pane.querySelector('.workflow__summary').textContent, actions: Array.from(pane.querySelectorAll('button')).filter(e => e.getBoundingClientRect().height > 0).map(e => e.textContent.trim()) } })()`
      const sourcePresentation = await ui.evaluate<any>(presentation), remotePresentation = await remote.evaluate<any>(presentation)
      assert.deepEqual(remotePresentation, { ...sourcePresentation, actions: sourcePresentation.actions.filter((action: string) => action !== 'Run in worktree') })
      await capture(ui, 'source-review')
      await capture(remote, 'remote-review')
      console.log('[smoke:ui] source and paired remote first automatic review is current; waiting words, tone and actions match')
      assert.equal((await run('svn', owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length, 1, 'Preparation waits without publication')
      await ui.evaluate(`Array.from(document.querySelectorAll('.worktree-validation details')).find(e => e.getBoundingClientRect().height > 0).open = true`)
      await ui.evaluate(`Array.from(document.querySelectorAll('input[aria-label="Application command"]')).find(e => e.getBoundingClientRect().height > 0).focus()`)
      await ui.call('Input.insertText', { text: 'node validate.cjs' })
      await click(ui, '.worktree-validation button', 'Run in worktree')
      let validationRun: { cwd: string; pid: number } | undefined
      await RemoteUiScenarios.until(async () => {
        validationRun = await readFile(join(proof.cwd, 'validation-proof.json'), 'utf8').then(JSON.parse).catch(() => undefined)
        return validationRun?.cwd.toLowerCase().replace(/\\/g, '/') === proof.cwd.toLowerCase().replace(/\\/g, '/')
      }, 'The managed validation application runs inside the prepared worktree')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`document.querySelector('[data-session="${id}"]').textContent.includes('Ready for validation')`), 'Waiting review badge survives the later running application')
      assert.equal(await ui.evaluate(`document.querySelector('.session-actions__review-header [role="status"]').textContent`), 'Ready for validation')
      console.log(`[smoke:ui] managed validation application PID ${validationRun!.pid} runs in the WT while publication waits`)
      await click(ui, '.session-actions__review button', 'Back to Session actions')
      await click(ui, '.session-actions button', 'Review changes')
      const acknowledgement = externals ? 'I checked this repository message' : 'I checked this message'
      const acknowledgementSelector = externals ? '.session-actions__repository label' : '.commit-actions label'
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll(${JSON.stringify(acknowledgementSelector)})).some(e => e.textContent.trim() === ${JSON.stringify(acknowledgement)})`), 'Proposed-message acknowledgement finding')
      assert.equal(await ui.evaluate(commitEnabled), false, 'Unacknowledged proposed markdown blocks Commit')
      assert.equal(await remote.evaluate(commitEnabled), false, 'Remote also blocks the proposed message')
      await ui.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(acknowledgementSelector)})).find(e => e.textContent.trim() === ${JSON.stringify(acknowledgement)}).querySelector('input').click()`)
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(commitEnabled), 'Current proposed-message acknowledgement enables Commit')
      await click(remote, '.commit-pane button', 'Select none')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.commit-target input')).every(e => !e.checked)`), 'Source receives cleared remote selection')
      await click(remote, '.commit-target input', 'Include new-dir/nested/file.txt')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.commit-target input')).some(e => e.checked && e.getAttribute('aria-label') === 'Include new-dir/nested/file.txt')`), 'Source receives remote nested-file selection')
      await message(ui, 'Shrnutí: U 043 zatím necommituj')
      await RemoteUiScenarios.until(async () => remote.evaluate<boolean>(messageIs('Shrnutí: U 043 zatím necommituj')), 'Shared person-written message')
      for (const client of clients) {
        await RemoteUiScenarios.until(async () => client.evaluate<boolean>(`!(${commitEnabled}) && document.body.innerText.includes('Include the whole verified change set')`), 'Incomplete selection blocks publication in both windows')
        assert.equal(await client.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(acknowledgementSelector)})).some(e => e.textContent.trim() === ${JSON.stringify(acknowledgement)})`), false)
      }
      await message(ui, '[repository]  ')
      await RemoteUiScenarios.until(async () => remote.evaluate<boolean>(messageIs('[repository]  ')), 'Shared prefix-only message')
      for (const client of clients)
        await RemoteUiScenarios.until(async () => client.evaluate<boolean>(`!(${commitEnabled}) && document.body.innerText.includes('Enter a commit message')`), 'Prefix without description blocks nested-file commit')
      await capture(ui, 'message-blocked')
      assert.equal((await run('svn', owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length, 1, 'Invalid messages publish nothing')
      console.log('[smoke:ui] proposed findings need acknowledgement; person-written hints do not; prefix-only message blocks selected nested file in both windows')
      await click(remote, '.commit-target input', 'Include worker.txt')
      await message(remote, '[repository] Publish reviewed Finish UI change')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(messageIs('[repository] Publish reviewed Finish UI change')), 'Source receives good remote message')
      if (!externals) await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions__review .commit-message')).some(e => e.textContent.includes('Source: person-remote'))`), 'Source draft retains remote message provenance before approval')
      await click(remote, '.commit-pane button', 'Select all')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions__review .commit-target input')).filter(e => e.getBoundingClientRect().height > 0).every(e => e.checked) && (${commitEnabled})`), 'Source receives the full selection before the final edit')
      await writeFile(join(proof.cwd, externals ? 'clean.txt' : 'worker.txt'), 'manually validated application change\n')
      await click(ui, '.session-actions__review button', 'Publish verified changes')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`document.body.innerText.includes('changed after preparation') || document.body.innerText.includes('shared review changed') || document.body.innerText.includes('Changed since this review was read')`), 'The edited application refuses old publication approval')
      assert.equal((await run('svn', owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length, 1)
      const updateCommands = async () => (await cli(['sessions', 'scripts', '--session-id', id])).value.runs
        .flatMap((run: any) => run.commands ?? []).filter((command: string) => command.startsWith('svn update'))
      const beforeRecheck = await updateCommands()
      await click(remote, '.session-actions button', 'Recheck local changes')
      await RemoteUiScenarios.until(async () => (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.sessions
        .find((row: any) => row.sessionId === id)?.worktreeView?.title === 'Ready for validation', 'Recheck finishes before editing the new review')
      for (const client of clients) await RemoteUiScenarios.until(async () => client.evaluate<boolean>(reviewVisible), 'Newly validated review after peer recheck')
      assert.deepEqual(await updateCommands(), beforeRecheck, 'Local recheck must not update SVN')
      await click(remote, '.commit-pane button', 'Select all')
      // Changed text proves the source read all queued peer edits before approval. An already enabled button does not.
      await message(remote, '[repository] Publish reviewed Finish UI change after validation')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(messageIs('[repository] Publish reviewed Finish UI change after validation')), 'Source receives the final repository message')
      if (externals) {
        await message(remote, '[library] Publish reviewed external change after validation', 'library', 'shared/library')
        await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(messageIs('[library] Publish reviewed external change after validation')), 'Source receives the final external message')
      }
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(commitEnabled), 'New full-set approval is available')
      await click(ui, '.session-actions__review button', 'Publish verified changes')
      await RemoteUiScenarios.until(async () => remote.evaluate<boolean>(`!(${commitEnabled}) && (document.body.innerText.includes('This review is outdated') || !(${reviewVisible}))`), 'Other window retires the approved review')
      assert.equal(await remote.evaluate(commitEnabled), false, 'The other window cannot approve the old review again')
      const observerOutdated = (await remote.evaluate<string>('document.body.innerText')).includes('This review is outdated')
      console.log(`[smoke:ui] remote edits and selection reach source; other window ${observerOutdated ? 'shows outdated' : 'retires its approved review'} and cannot approve it twice`)
      await RemoteUiScenarios.until(async () => (await run('svn', owner, ['log', '--xml', '-r', 'HEAD'])).includes('Publish reviewed Finish UI change'), 'Reviewed publication')
      // A published Finish updates its main copy by itself: no Update press, no live-session confirmation (Finish 072).
      await RemoteUiScenarios.until(async () => (await readFile(join(owner, externals ? 'clean.txt' : 'worker.txt'), 'utf8')).includes('manually validated application change'), 'Main copy UPDATE starts by itself after the publication')
      await RemoteUiScenarios.until(async () => {
        const status = (await ui.bridge<any>(`window.appClient.control.call('host.status', {})`)).value
        return !status.runtimes.some((row: any) => row.runtimeSessionId === runtime.runtimeSessionId && row.alive)
      }, 'Finish stopped the actual worker runtime')
      await RemoteUiScenarios.until(async () => { try { process.kill(proof.pid, 0); return false } catch { return true } }, 'Finish stopped the stand-in process')
      await assert.rejects(access(proof.cwd), 'Finish removed its verified worktree')
      console.log(`[smoke:ui] Finish stopped runtime ${runtime.runtimeSessionId} and stand-in PID ${proof.pid}, then removed its verified worktree`)
      await RemoteUiScenarios.until(async () => { try { process.kill(validationRun!.pid, 0); return false } catch { return true } }, 'Owned validation application exited before cleanup')
      const host = (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.host
      const descriptor = JSON.parse(await readFile(source.hostFile, 'utf8'))
      assert.equal(host.hostInstanceId, descriptor.hostInstanceId, 'Stop targets only the fixture source Host')
      const stopped = await ui.bridge<any>(`window.appClient.control.call('host.stop', { expectedHostInstanceId: ${JSON.stringify(host.hostInstanceId)} })`)
      assert(stopped.ok, JSON.stringify(stopped))
      await RemoteUiScenarios.until(async () => (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.host.presence !== 'running', 'Private source Host stopped')
      await RemoteUiScenarios.until(async () => { try { process.kill(descriptor.pid, 0); return false } catch { return true } }, 'Private source Host process exited')
      console.log(`[smoke:ui] public host.stop retired fixture Host ${host.hostInstanceId}; owned PID ${descriptor.pid} has exited`)
      assert.equal(await ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions button')).some(e => e.textContent === 'Update' && !e.disabled)`), false,
        'No Update press is left after the automatic UPDATE')
      assert.equal(await readFile(join(owner, 'new-dir/nested/file.txt'), 'utf8'), 'reviewed nested file\n')
      if (externals) {
        await RemoteUiScenarios.until(async () => (await readFile(join(owner, 'shared/library/lib.cjs'), 'utf8')) === 'module.exports = 2\n', 'Main external receives its published revision')
        assert.equal(await readFile(join(owner, 'carrier/added/lib.cjs'), 'utf8'), 'module.exports = 1\n')
        assert.match(await run('svn', owner, ['info', '--xml', 'title.txt']), /path="title.txt"/)
        assert.equal((await run('svn', owner, ['log', '--xml', '-r', '1:HEAD', pathToFileURL(library).href])).match(/<logentry/g)?.length, 2)
        assert.equal((await run('svn', owner, ['log', '--xml', '-r', '1:HEAD', pathToFileURL(addedLibrary).href])).match(/<logentry/g)?.length, 1)
        console.log('[smoke:ui] external published once; case-only rename, new external carrier and previously clean edit reached main')
      }
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.session-actions__section[aria-label^="UPDATE"] .session-actions__toggle')).some(e => e.textContent === 'Show details: svn update')`), 'UPDATE log control')
      await click(ui, '.session-actions__section[aria-label^="UPDATE"] .session-actions__toggle', 'Show details: svn update')
      await RemoteUiScenarios.until(async () => ui.evaluate<boolean>(`Array.from(document.querySelectorAll('.task-view')).some(e => e.getBoundingClientRect().height > 0 && e.textContent.includes('Saved log') && e.querySelector('[data-testid="script-output-text"]')?.textContent.includes('worker.txt'))`), 'Saved UPDATE log after Host stop')
      await capture(ui, 'update-saved-log')
      const afterUpdate = (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.sessions.find((row: any) => row.sessionId === id)
      await writeFile(join(repo, '.aidocs/temp/finish-ui-update.json'), JSON.stringify(afterUpdate ?? { sessionRemoved: true }, null, 2) + '\n')
      console.log(`[smoke:ui] UPDATE action history: ${JSON.stringify(afterUpdate?.actions ?? { sessionRemoved: true })}`)
      let settled: any
      try {
        await RemoteUiScenarios.until(async () => {
          const snapshot = (await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value
          const results = (await ui.bridge<any>(`window.appClient.control.call('sessions.worktreeResults', { sessionId: ${JSON.stringify(id)} })`)).value.results
          const session = snapshot.sessions.find((row: any) => row.sessionId === id)
          settled = { session, results }
          return results.some((result: any) => result.result === 'committed' && result.main?.revision === 2 && result.holdsLanded === true)
            && session?.retiredWorktree?.landing === undefined
        }, 'Main UPDATE settles to landed in the public result and source snapshot')
      } finally {
        await writeFile(join(repo, '.aidocs/temp/finish-ui-settled.json'), JSON.stringify(settled, null, 2) + '\n')
        console.log(`[smoke:ui] post-UPDATE source state: ${JSON.stringify(settled)}`)
      }
      if (settled.session !== undefined) await capture(ui, 'update-landed')
      assert.notEqual((await ui.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.host.presence, 'running', 'UPDATE must not restart the Host')
      const list = await ui.bridge<any>(`window.appClient.control.call('sessions.worktreeResults', { sessionId: ${JSON.stringify(id)} })`)
      assert(list.ok && JSON.stringify(list).includes('committed'), JSON.stringify(list))
      if (!externals) assert.equal(list.value.results.find((result: any) => result.result === 'committed')?.messageSource, 'person-remote', 'Local approval preserves unchanged remote message provenance')
      assert.equal((await run('svn', owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length, 2)
      console.log('[smoke:ui] DOM Finish, Review, Commit and Host-independent UPDATE published exactly once; saved UPDATE log is visible')
      console.log(realAgent ? '[smoke:ui] Native Claude performed fixture edits through its real Host PTY; prepared review, publication, Stop and removal passed'
        : '[smoke:ui] Host-managed stand-in proves launch identity and Stop, not native conversation recovery; that acceptance remains a separate real-agent check')
    } catch (error) {
      await mkdir(join(repo, '.aidocs/temp'), { recursive: true })
      if (clients[0]) {
        const sessions = await clients[0].bridge<any>(`window.appClient.control.call('sessions.list', {})`).catch(() => null)
        for (const session of sessions?.value?.sessions ?? []) {
          const scripts = await clients[0].bridge<any>(`window.appClient.control.call('sessions.scripts', { session: { kind: 'sessionId', sessionId: ${JSON.stringify(session.sessionId)} } })`).catch(String)
          console.error(`Fixture scripts ${session.sessionId}: ${JSON.stringify(scripts)}`)
        }
      }
      const snapshots = await Promise.all(clients.map(async (client, index) => {
        await capture(client, `failure-${index}`).catch(() => {})
        const views = await client.bridge<any>(index === 0 ? `window.appClient.control.call('sessions.list', {})` : remoteReference === undefined ? 'window.appClient.remote.snapshot()'
          : `window.appClient.remote.readView(${JSON.stringify(remoteReference.endpoint)}, ${JSON.stringify(remoteReference.viewId)})`)
          .then((answer) => (index === 0 ? answer.value.sessions : remoteReference === undefined ? answer.outbound.flatMap((entry: any) => entry.sessions?.sessions ?? []) : [answer.value.session])
            .map((session: any) => ({ sessionId: session.sessionId, worktreeView: session.worktreeView, actions: session.actions }))).catch(String)
        return `Window ${index}\n${await client.evaluate('document.body.innerText').catch(String)}\nViews: ${JSON.stringify(views)}\nButtons: ${JSON.stringify(await client.evaluate(`Array.from(document.querySelectorAll('button')).map(e => ({ text: e.textContent, title: e.title, aria: e.getAttribute('aria-label'), disabled: e.disabled, height: e.getBoundingClientRect().height }))`).catch(String))}`
      }))
      await writeFile(join(repo, '.aidocs/temp/finish-ui.log'), `${String(error)}\n${logs.map((log) => `${log.label}\n${log.text}`).join('\n')}\n${snapshots.join('\n')}`)
      throw error
    } finally {
      await mkdir(join(repo, '.aidocs/temp'), { recursive: true })
      await writeFile(join(repo, '.aidocs/temp/finish-ui-clients.log'), logs.map((log) => `${log.label}\n${log.text}`).join('\n'))
      for (const [index, client] of clients.entries()) {
        const descriptor = await readFile(hosts[index]!, 'utf8').then(JSON.parse).catch(() => null)
        if (descriptor === null) continue
        try {
          const status = await client.bridge<any>(`window.appClient.control.call('host.status', {})`)
          if (status.value.presence === 'running' && status.value.descriptor?.hostInstanceId === descriptor.hostInstanceId)
            await client.bridge(`window.appClient.control.call('host.stop', { expectedHostInstanceId: ${JSON.stringify(descriptor.hostInstanceId)} })`)
        } catch (error) { console.warn(`[smoke:ui] fixture Host cleanup: ${String(error)}`) }
      }
      for (const client of clients) client.close()
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        child.kill(); await RemoteUiScenarios.until(async () => child.exitCode !== null || child.signalCode !== null, 'Finish UI client stopped')
      }
      for (const hostFile of hosts) {
        const descriptor = await readFile(hostFile, 'utf8').then(JSON.parse).catch(() => null)
        if (descriptor !== null) hostPids.add(descriptor.pid)
      }
      for (const pid of hostPids) {
        try { process.kill(pid) } catch {}
        await RemoteUiScenarios.until(async () => { try { process.kill(pid, 0); return false } catch { return true } }, 'Finish UI private Host stopped')
      }
      const proof = await readFile(join(root, 'worker-proof.json'), 'utf8').then(JSON.parse).catch(() => null)
      if (proof !== null) {
        try {
          process.kill(proof.pid, 0)
          await run('taskkill', root, ['/pid', String(proof.pid), '/T', '/F'])
          await RemoteUiScenarios.until(async () => { try { process.kill(proof.pid, 0); return false } catch { return true } }, 'Fixture stand-in process cleaned')
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      if (previousState === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
      else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousState
      if (previousHost === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
      else process.env.JAMAT_V3_HOST_STATE_DIR = previousHost
      const relativeRoot = relative(parent, root)
      assert(relativeRoot && !relativeRoot.startsWith('..') && !isAbsolute(relativeRoot), 'Cleanup remains inside the selected fixture parent')
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}
