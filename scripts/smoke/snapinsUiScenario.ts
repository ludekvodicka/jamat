import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { CatalogSection } from '../../lib-orchestrator/projectManager/catalog/catalogSection.js'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths.js'
import type { SnapinStateDocument } from '../../lib-orchestrator/snapins/shared/snapinContract.js'
import { RemoteUiScenarios, WorkspaceCdp } from './remoteUiScenarios.js'

export class SnapinsUiScenario {
  static async run(): Promise<void> {
    const repo = join(import.meta.dirname, '..', '..'), root = await mkdtemp(join(tmpdir(), 'jamat-snapins-ui-'))
    const previousState = process.env.JAMAT_V3_LOCAL_STATE_DIR, previousHost = process.env.JAMAT_V3_HOST_STATE_DIR
    const diagnostics = join(repo, `.aidocs/temp/${new Date().toISOString().slice(0, 10)}-snapins-ui`), screenshots = join(repo, '.aidocs/screenshots')
    let child: ChildProcess | undefined, ui: WorkspaceCdp | undefined, main: WorkspaceCdp | undefined
    let hostPid: number | undefined, log = ''
    const proofs = join(root, 'workers.jsonl')
    let env: NodeJS.ProcessEnv = { ...process.env }
    const run = async (command: string, cwd: string, args: string[]) => {
      const result = await new CommandInvoker().run({ command, cwd, args, env, timeoutMs: 60000 })
      assert.equal(result.failure, null, JSON.stringify(result)); assert.equal(result.code, 0, result.stderr || result.stdout)
      return result.stdout
    }
    try {
      await mkdir(diagnostics, { recursive: true }); await mkdir(screenshots, { recursive: true })
      const profile = await RemoteUiScenarios.seed(root, 'snapins')
      const { configIdentity } = ConfigIdentityStore.loadOrCreate(profile.configDir, 'development')
      env = { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: profile.stateRoot, JAMAT_V3_HOST_STATE_DIR: join(profile.stateRoot, 'host'),
        JAMAT_V3_CONFIG_DIR: profile.configDir, JAMAT_V3_RUNTIME_CHANNEL: 'development', JAMAT_V3_SKIP_SKILL_LINKS: '1',
        CLAUDE_CONFIG_DIR: profile.configDir, CODEX_HOME: profile.configDir }
      delete env.ELECTRON_RUN_AS_NODE
      const repository = join(root, 'repository'), tools = join(root, 'Tools'), owner = join(tools, 'Scratch')
      await run('svnadmin', root, ['create', repository])
      await run('svn', root, ['checkout', pathToFileURL(repository).href, tools])
      await mkdir(join(owner, '.aidocs/review-todos'), { recursive: true }); await mkdir(join(tools, 'Other'))
      await writeFile(join(tools, '.appgroup'), '{"kind":"collection"}')
      await writeFile(join(tools, 'Other/control.txt'), 'unrelated application\n')
      for (const id of [900, 901, 904]) await writeFile(join(owner, `.aidocs/review-todos/${id}-pending-p2-scratch.md`),
        `---\nstatus: ${id === 904 ? 'ready' : 'pending'}\npriority: p2\n---\nDisposable test ${id}\n`)
      await run('svn', tools, ['add', '.appgroup', 'Scratch', 'Other'])
      await run('svn', owner, ['propset', 'svn:global-ignores', '.worktrees', '.'])
      const seed = join(root, 'seed.txt'); await writeFile(seed, 'Seed disposable snap-ins walkthrough')
      await run('svn', tools, ['commit', '--file', seed]); await run('svn', tools, ['update'])
      assert(profile.config.saveSection(CatalogSection.spec, [{ id: 'scratch', label: 'Fixture', path: tools }]).ok)
      const agents = join(root, 'agents'); await mkdir(agents)
      const idle = JSON.parse(await readFile(join(repo, 'lib-orchestrator/sessionManager/workState/fixtures/claude-idle-prompt.json'), 'utf8'))
      await writeFile(join(agents, 'stand-in.cjs'), [
        "const { appendFileSync } = require('node:fs')",
        `appendFileSync(${JSON.stringify(proofs)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n')`,
        `const prompt = ${JSON.stringify(`\x1b[2J\x1b[H${idle.frame.screenTail}\n`)}`,
        'process.stdout.write(prompt)', 'setInterval(() => process.stdout.write(prompt), 1000)',
      ].join('\n'))
      await writeFile(join(agents, 'claude.cmd'), `@"${process.execPath}" "%~dp0stand-in.cjs" %*\r\n`)
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      env[pathKey] = `${agents}${delimiter}${env[pathKey] ?? ''}`
      const start = async () => {
        const inspectorPort = await RemoteUiScenarios.port(), rendererPort = await RemoteUiScenarios.port()
        child = spawn(join(repo, 'app-client-ui/node_modules/electron/dist/electron.exe'), [join(repo, 'app-client-ui'),
          `--inspect=127.0.0.1:${inspectorPort}`, `--remote-debugging-port=${rendererPort}`, '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true })
        await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject) })
        child.stdout?.on('data', (bytes) => { log += bytes.toString() }); child.stderr?.on('data', (bytes) => { log += bytes.toString() })
        ui = await WorkspaceCdp.connect(rendererPort)
        const targets = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as { webSocketDebuggerUrl: string }[]
        const socket = new WebSocket(targets[0]!.webSocketDebuggerUrl)
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
        main = new WorkspaceCdp(socket)
        await RemoteUiScenarios.until(async () => (await ui!.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.host.presence === 'running', 'Snap-ins private Host ready')
        await RemoteUiScenarios.until(async () => (await ui!.bridge<any>(`window.appClient.control.call('host.status', {})`)).value.lease.leaseId !== null, 'Restarted client owns the Host lease')
        hostPid = JSON.parse(await readFile(profile.hostFile, 'utf8')).pid
      }
      const stopClient = async () => {
        await main!.evaluate(`process.getBuiltinModule('module').createRequire(process.cwd() + '/fixture.cjs')('electron').app.quit()`).catch(() => {})
        ui?.close(); main?.close(); ui = undefined; main = undefined
        await RemoteUiScenarios.until(async () => child!.exitCode !== null || child!.signalCode !== null, 'Fixture client exited')
      }
      const menu = async (label: string, parent?: string) => {
        const items = `process.getBuiltinModule('module').createRequire(process.cwd() + '/fixture.cjs')('electron').Menu.getApplicationMenu().items`
        await main!.evaluate(`(() => { const items = ${parent ? `${items}.find(e => e.label === ${JSON.stringify(parent)}).submenu.items` : `${items}.flatMap(e => e.submenu?.items ?? [])`}; const item = items.find(e => e.label === ${JSON.stringify(label)}); if (!item) throw new Error('Missing menu item'); item.click(); })()`)
      }
      const click = async (selector: string, label: string) => {
        const expression = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.getBoundingClientRect().height > 0 && !e.disabled && (e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)}))`
        await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`!!(${expression})`), `Snap-ins button ${label}`)
        await ui!.evaluate(`(${expression}).click()`)
      }
      const type = async (selector: string, value: string) => {
        await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`), 'Editable input is ready')
        await ui!.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
        await ui!.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
        await ui!.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
        await ui!.call('Input.insertText', { text: value })
      }
      const statePath = join(OrchestratorPaths.snapinsDirectory(configIdentity, 'development'), 'review-todos', 'state.json')
      const state = async (): Promise<SnapinStateDocument> => JSON.parse(await readFile(statePath, 'utf8'))
      const sessions = async () => (await ui!.bridge<any>(`window.appClient.control.call('sessions.list', {})`)).value.sessions as any[]
      const session = async (id: string) => (await sessions()).find((row) => row.sessionId === id)
      const group = async (id: string) => (await ui!.bridge<any[]>(`window.appClient.state.loadSessionGroups()`)).find((row) => row.key.endsWith(id))?.group
      const event = async (attemptId: string) => {
        const detail = join(root, 'detail.md'); await writeFile(detail, 'Disposable worker ready for review')
        await run(process.execPath, repo, ['--import', 'tsx', join(repo, 'app-client-cli/start.ts'), 'snapins', 'pass', 'event',
          '--pass', join(statePath, '..', 'passes', attemptId), '--kind', 'done', '--outcome', 'ready', '--detail-file', detail])
      }
      const openWorker = async (id: string) => {
        await ui!.bridge(`window.appClient.control.call('tabs.open', { session: { kind: 'sessionId', sessionId: ${JSON.stringify(id)} } })`)
        const rect = await ui!.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-session="${id}"] .jamat-sessions__row').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
        await ui!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
      }
      await start()
      await menu('Review todos', 'Tasks')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`document.querySelector('.snapins')?.textContent.includes('status drift') === true`), 'Tasks listing and held status drift')
      await menu('Review todos', 'Tasks')
      assert.equal(await ui!.evaluate(`document.querySelectorAll('.snapins').length`), 1, 'Tasks focuses its existing panel')
      await menu('Settings')
      await click('button', 'Snap-ins')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`!!document.querySelector('[aria-label="Concurrent worker limit"]')`), 'Snap-ins settings loaded')
      await type('[aria-label="Concurrent worker limit"]', '1')
      await type('[aria-label="Claude worker prompt"]', 'Reply fixture and wait. Pass: {pass}')
      await click('.snapins-settings button', 'Save')
      await RemoteUiScenarios.until(async () => {
        const value = (await ui!.bridge<any>(`window.appClient.control.call('snapins.settings.get', {})`)).value.settings
        return value.limit === 1 && value.workerPrompts.claude === 'Reply fixture and wait. Pass: {pass}'
      }, 'Explicit Save persisted worker settings')
      await ui!.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await ui!.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await stopClient(); await start()
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`document.querySelector('.snapins')?.textContent.includes('Todo 900') === true`), 'Restored Tasks tab after client restart')
      const restored = (await ui!.bridge<any>(`window.appClient.control.call('snapins.settings.get', {})`)).value.settings
      assert.equal(restored.limit, 1); assert.equal(restored.workerPrompts.claude, 'Reply fixture and wait. Pass: {pass}')
      console.log('[smoke:ui] snap-ins Tasks menu focuses one tab; tab and explicitly saved settings survive restart')
      await click('.snapins input', 'Select Todo 900: scratch'); await click('.snapins input', 'Select Todo 901: scratch')
      await click('.snapins button', 'Solve selected')
      await RemoteUiScenarios.until(async () => access(statePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      }), 'Snap-ins queue persisted')
      await RemoteUiScenarios.until(async () => { const doc = await state(); return doc.attempts.length === 1 && !!doc.attempts[0]?.sessionId && doc.queue.length === 1 }, 'One WT worker and one queued item')
      const first = (await state()).attempts[0]!
      await RemoteUiScenarios.until(async () => (await session(first.sessionId!))?.activity === 'idle', 'First fixture worker idle')
      const live = await session(first.sessionId!)
      assert.equal(await group(first.sessionId!), 'automation'); assert.equal(live.color, 'cyan')
      assert.equal(live.worktree.branch, `${pathToFileURL(repository).href}/Scratch`)
      assert.equal(dirname(dirname(live.worktree.worktreePath)), owner)
      await assert.rejects(access(join(live.worktree.worktreePath, 'Other')), 'Collection worker excludes sibling application')
      await click('.snapins button', 'Dequeue')
      await RemoteUiScenarios.until(async () => (await state()).queue.length === 0, 'Second item dequeued')
      await event(first.attemptId)
      await RemoteUiScenarios.until(async () => (await state()).attempts[0]?.phase === 'review', 'Ready event waits for human review')
      await RemoteUiScenarios.until(async () => (await session(first.sessionId!))?.note === 'Waits for your review: Finish or commit', 'Review note shown')
      assert.equal(await group(first.sessionId!), 'waiting')
      const tree = live.worktree.worktreePath
      await run('svn', tree, ['move', '.aidocs/review-todos/900-pending-p2-scratch.md', '.aidocs/review-todos/900-complete-p2-scratch.md'])
      await writeFile(join(tree, '.aidocs/review-todos/900-complete-p2-scratch.md'), '---\nstatus: complete\npriority: p2\n---\nCompleted fixture\n')
      await openWorker(first.sessionId!); await click(`[data-session="${first.sessionId}"] button`, 'Finish…')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`!!document.querySelector('.session-actions__review .commit-message textarea')`), 'Todo Finish review')
      await type('.session-actions__review .commit-message textarea', '[repository] Complete disposable todo')
      await click('.session-actions__review button', 'Commit')
      await RemoteUiScenarios.until(async () => (await state()).attempts[0]?.phase === 'completed', 'One approval immediately after typing completes the task')
      assert.equal((await state()).attempts[0]?.phase, 'completed', 'Published completed filename settles the attempt')
      const done = await session(first.sessionId!)
      if (done) { assert.equal(await group(first.sessionId!), 'completed'); assert.equal(done.note, 'Done') }
      assert.equal((await run('svn', owner, ['log', '--xml', '-r', '1:HEAD'])).match(/<logentry/g)?.length, 2)
      console.log('[smoke:ui] limit admits one collection WT; ready event waits; reviewed Finish publication completes the source task')
      await menu('Review todos', 'Tasks')
      // The listing reads files only; the stale main-copy filename is found by the svn check of the todo being started.
      await ui!.evaluate(`Array.from(document.querySelectorAll('.snapins input[type="checkbox"]')).forEach(e => { const wanted = e.getAttribute('aria-label') === 'Select Todo 900: scratch'; if (e.checked !== wanted) e.click() })`)
      await click('.snapins button', 'Solve selected')
      await RemoteUiScenarios.until(async () => ui!.evaluate<boolean>(`document.body.innerText.includes('Published in SVN; update the main copy to receive the completed task')`), 'Solve explains the stale main-copy filename')
      assert.equal((await state()).attempts.length, 1, 'A refused todo starts no worker')
      await ui!.evaluate(`Array.from(document.querySelectorAll('.snapins input[type="checkbox"]')).forEach(e => { const wanted = e.getAttribute('aria-label') === 'Select Todo 901: scratch'; if (e.checked !== wanted) e.click() })`)
      await click('.snapins button', 'Solve selected')
      await RemoteUiScenarios.until(async () => (await state()).attempts.length === 2 && !!(await state()).attempts[1]?.sessionId, 'Second worker starts')
      const second = (await state()).attempts[1]!
      await RemoteUiScenarios.until(async () => (await session(second.sessionId!))?.activity === 'idle', 'Second fixture worker idle')
      const secondTree = (await session(second.sessionId!)).worktree.worktreePath
      await writeFile(join(secondTree, 'unfinished.txt'), 'Retain this in the Discard preservation bundle\n')
      await stopClient()
      await event(second.attemptId)
      await start()
      await RemoteUiScenarios.until(async () => (await state()).attempts[1]?.phase === 'review', 'Offline event replay after restart')
      assert.equal((await state()).attempts.length, 2)
      assert.equal((await readFile(proofs, 'utf8')).trim().split('\n').length, 2, 'Restart did not create another worker')
      await openWorker(second.sessionId!); await click(`[data-session="${second.sessionId}"] button`, 'Finish…')
      await click('.session-actions button', 'Back to Session actions')
      await click('.session-actions button', 'Discard')
      await click('.session-actions button', 'Confirm Discard')
      await RemoteUiScenarios.until(async () => (await state()).attempts[1]?.phase === 'ended', 'Discard ends the attempt')
      assert.equal((await state()).attempts[1]?.endedReason, 'discarded')
      assert.equal(await readFile(join(tools, 'Other/control.txt'), 'utf8'), 'unrelated application\n')
      assert.equal((await run('svn', tools, ['status', '--ignore-externals'])).trim(), '')
      console.log('[smoke:ui] offline replay preserves one worker; Discard ends its attempt; sibling bytes and main status stay unchanged')
      await menu('Review todos', 'Tasks')
      await ui!.capture(join(screenshots, 'snapins-overnight-completed-1440x900.png'))
    } catch (error) {
      if (ui) {
        log += `\nDOM:\n${await ui.evaluate('document.body.innerText').catch(String)}`
        await ui.capture(join(screenshots, 'snapins-overnight-failure-1440x900.png')).catch(() => {})
      }
      throw error
    } finally {
      await mkdir(diagnostics, { recursive: true }); await writeFile(join(diagnostics, 'snapins-ui-clients.log'), log)
      if (ui) {
        const host = await ui.bridge<any>(`window.appClient.control.call('host.status', {})`).catch(() => null)
        if (host?.value?.descriptor?.pid === hostPid)
          await ui.bridge(`window.appClient.control.call('host.stop', { expectedHostInstanceId: ${JSON.stringify(host.value.descriptor.hostInstanceId)} })`).catch(() => {})
      }
      ui?.close(); main?.close()
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill(); await RemoteUiScenarios.until(async () => child!.exitCode !== null || child!.signalCode !== null, 'Snap-ins client cleanup')
      }
      if (hostPid) { try { process.kill(hostPid) } catch {} }
      for (const proof of (await readFile(proofs, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))) {
        try { process.kill(proof.pid) } catch {}
      }
      if (previousState === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
      else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousState
      if (previousHost === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
      else process.env.JAMAT_V3_HOST_STATE_DIR = previousHost
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  }
}
