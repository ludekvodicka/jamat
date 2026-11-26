import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { CliClient } from '../smoke/cliClient.js'
import { prepareSkills } from './prepare-skills.js'

test('distributed skills run outside the checkout with no tsx or node_modules', async () => {
  const root = resolve(import.meta.dirname, '../..')
  const output = mkdtempSync(join(tmpdir(), 'jamat skills package '))
  try {
    await prepareSkills(root, output)
    const signalProbe = join(output, 'signal-probe.cjs')
    writeFileSync(signalProbe, `
      const { writeFileSync } = require('node:fs')
      const abort = AbortController.prototype.abort
      AbortController.prototype.abort = function(reason) {
        const before = this.signal.aborted
        const result = Reflect.apply(abort, this, [reason])
        writeFileSync(process.env.JAMAT_V3_TEST_CLI_WRAPPER_SIGNAL_RECEIPT,
          JSON.stringify({ pid: process.pid, before, after: this.signal.aborted }))
        return result
      }
      process.on('newListener', event => {
        if (event === process.env.JAMAT_V3_TEST_CLI_WRAPPER_SIGNAL)
          process.nextTick(() => process.emit(event))
      })
    `)
    for (const agent of ['claude', 'codex', 'antigravity']) {
      const cli = spawnSync(process.execPath, [join(output, 'skills', agent, 'appjamat-v3/scripts/jamat-v3.mjs'), '--help'],
        { encoding: 'utf8', windowsHide: true, cwd: output })
      assert.equal(cli.status, 0, cli.stderr + cli.stdout)
      assert.match(JSON.parse(cli.stdout).value.usage, /^jamat-v3 <command>/)
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const receipt = join(output, agent + '-' + signal + '.json')
        const signalled = spawnSync(process.execPath,
          [join(output, 'skills', agent, 'appjamat-v3/scripts/jamat-v3.mjs'), '--help'], {
            encoding: 'utf8', windowsHide: true, cwd: output, timeout: 5000,
            env: { ...process.env, JAMAT_V3_TEST_CLI_WRAPPER_SIGNAL: signal, JAMAT_V3_TEST_CLI_WRAPPER_SIGNAL_RECEIPT: receipt,
              NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --require="' + signalProbe.replaceAll('\\', '/') + '"' },
          })
        assert.equal(signalled.status, 0, signalled.stderr + signalled.stdout)
        assert.match(JSON.parse(signalled.stdout).value.usage, /^jamat-v3 <command>/)
        assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')),
          { pid: signalled.pid, before: false, after: true })
      }
      const smokeCli = new CliClient({ cwd: output, timeoutMilliseconds: 5000,
        configDir: join(output, 'missing-private-config'), stateRoot: join(output, 'private-state'),
        wrapperPath: join(output, 'skills', agent, 'appjamat-v3/scripts/jamat-v3.mjs') })
      const answer = await smokeCli.runFailure(6, 'status')
      assert.equal(answer.operation, 'system.status')
      assert.equal(answer.ok, false)
      assert.equal(answer.error?.code, 'unavailable')
      assert.match(String(answer.error?.detail), /No AppClientUI config identity/)
      const helper = spawnSync(process.execPath, [join(output, 'skills', agent,
        'session-automation-groups/scripts/session-automation-groups.mjs'), 'describe', '--state', 'completed'],
      { encoding: 'utf8', windowsHide: true, cwd: output })
      assert.equal(helper.status, 0, helper.stderr)
      assert.deepEqual(JSON.parse(helper.stdout), { ok: true, value: { state: 'completed', color: 'blue' } })
    }
    const sourceCli = new CliClient({ cwd: output, timeoutMilliseconds: 5000,
      configDir: join(output, 'missing-private-config'), stateRoot: join(output, 'private-state') })
    const sourceAnswer = await sourceCli.runFailure(6, 'status')
    assert.equal(sourceAnswer.operation, 'system.status')
    assert.equal(sourceAnswer.error?.code, 'unavailable')
  } finally { rmSync(output, { recursive: true, force: true }) }
})

test('distributed wrappers keep arguments, process state and delayed exits without another Node process', () => {
  const root = resolve(import.meta.dirname, '../..')
  const output = mkdtempSync(join(tmpdir(), 'jamat wrapper contract '))
  try {
    const bundle = join(output, 'cli/jamat-v3.cjs')
    mkdirSync(join(output, 'cli'), { recursive: true })
    const body = `
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ pid: process.pid, argv: process.argv,
          execArgv: process.execArgv, cwd: process.cwd(), value: process.env.JAMAT_V3_TEST_CLI_WRAPPER_VALUE }) + '\\n')
        process.exitCode = 23
      }, 20)
    `
    const args = ['argument with spaces', 'quote"value', 'trailing\\', '']
    for (const agent of ['claude', 'codex', 'antigravity']) {
      const directory = join(output, 'skills', agent, 'appjamat-v3/scripts')
      mkdirSync(directory, { recursive: true })
      const wrapper = join(directory, 'jamat-v3.mjs')
      const original = join(root, 'skills', agent, 'appjamat-v3/scripts/jamat-v3.mjs')
      copyFileSync(original, wrapper)
      assert.deepEqual(readFileSync(wrapper), readFileSync(original))
      writeFileSync(bundle, body)
      for (const execArgv of [[], ['--no-warnings']]) {
        const child = spawnSync(process.execPath, [...execArgv, wrapper, ...args], {
          encoding: 'utf8', windowsHide: true, cwd: output, timeout: 5000,
          env: { ...process.env, JAMAT_V3_TEST_CLI_WRAPPER_VALUE: 'inherited value with spaces' },
        })
        assert.equal(child.error, undefined)
        assert.equal(child.status, 23, child.stderr + child.stdout)
        assert.equal(child.stderr, '')
        const result = JSON.parse(child.stdout)
        assert.deepEqual(result.argv, [process.execPath, bundle, ...args])
        assert.deepEqual(result.execArgv, [])
        assert.equal(result.cwd, output)
        assert.equal(result.value, 'inherited value with spaces')
        if (execArgv.length === 0) assert.equal(result.pid, child.pid)
        else assert.notEqual(result.pid, child.pid)
      }
      writeFileSync(bundle, "throw new Error('fixture bundle load failed')\n")
      const broken = spawnSync(process.execPath, [wrapper],
        { encoding: 'utf8', windowsHide: true, cwd: output, timeout: 5000 })
      assert.equal(broken.error, undefined)
      assert.equal(broken.status, 1)
      assert.equal(broken.stdout, '')
      assert.match(broken.stderr, /Error: fixture bundle load failed/)
      assert.doesNotMatch(broken.stderr, /AppJamatV3 CLI could not start/)
    }
    assert.deepEqual(readFileSync(join(root, 'skills/claude/appjamat-v3/scripts/jamat-v3.mjs')),
      readFileSync(join(root, 'skills/codex/appjamat-v3/scripts/jamat-v3.mjs')))
    assert.deepEqual(readFileSync(join(root, 'skills/claude/appjamat-v3/scripts/jamat-v3.mjs')),
      readFileSync(join(root, 'skills/antigravity/appjamat-v3/scripts/jamat-v3.mjs')))
  } finally { rmSync(output, { recursive: true, force: true }) }
})

test('source checkout wrapper uses fresh prebuilt dev bundle and falls back to tsx when stale, missing or opted out', () => {
  const root = resolve(import.meta.dirname, '../..')
  const checkout = mkdtempSync(join(tmpdir(), 'jamat dev bundle '))
  try {
    const cliSource = join(checkout, 'app-client-cli/start.ts')
    const libSource = join(checkout, 'lib-orchestrator/clientApi/contract.ts')
    const fakeTsx = join(checkout, 'app-client-cli/node_modules/tsx/dist/cli.mjs')
    const devBundle = join(checkout, 'out/skills-bundle/cli/jamat-v3.cjs')
    mkdirSync(join(checkout, 'app-client-cli/node_modules/tsx/dist'), { recursive: true })
    mkdirSync(join(checkout, 'lib-orchestrator/clientApi'), { recursive: true })
    mkdirSync(join(checkout, 'out/skills-bundle/cli'), { recursive: true })
    writeFileSync(cliSource, 'export {}\n')
    writeFileSync(libSource, 'export {}\n')
    writeFileSync(join(checkout, 'app-client-cli/tsconfig.json'), '{}')
    writeFileSync(fakeTsx, "process.stdout.write(JSON.stringify({ via: 'tsx', args: process.argv.slice(2) }) + '\\n')\n")
    writeFileSync(devBundle, "process.stdout.write(JSON.stringify({ via: 'bundle', pid: process.pid, args: process.argv.slice(2) }) + '\\n')\n")

    const baseSeconds = Math.floor(Date.now() / 1000)
    const setTime = (file: string, offsetSeconds: number) => utimesSync(file, baseSeconds + offsetSeconds, baseSeconds + offsetSeconds)
    setTime(cliSource, -20)
    setTime(libSource, -20)
    setTime(join(checkout, 'app-client-cli/tsconfig.json'), -20)
    setTime(devBundle, 0)

    for (const agent of ['claude', 'codex', 'antigravity']) {
      const directory = join(checkout, 'skills', agent, 'appjamat-v3/scripts')
      mkdirSync(directory, { recursive: true })
      const wrapper = join(directory, 'jamat-v3.mjs')
      copyFileSync(join(root, 'skills', agent, 'appjamat-v3/scripts/jamat-v3.mjs'), wrapper)

      // Fresh bundle: runs directly in-process without spawning tsx.
      const fresh = spawnSync(process.execPath, [wrapper, 'status'],
        { encoding: 'utf8', windowsHide: true, cwd: checkout, timeout: 5000 })
      assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout)
      const freshOut = JSON.parse(fresh.stdout)
      assert.equal(freshOut.via, 'bundle')
      assert.equal(freshOut.pid, fresh.pid)
      assert.deepEqual(freshOut.args, ['status'])

      // Opt-out env var forces tsx fallback even when the bundle is fresh.
      const optOut = spawnSync(process.execPath, [wrapper, 'status'], {
        encoding: 'utf8', windowsHide: true, cwd: checkout, timeout: 5000,
        env: { ...process.env, JAMAT_V3_CLI_NO_BUNDLE: '1' },
      })
      assert.equal(optOut.status, 0, optOut.stderr + optOut.stdout)
      assert.equal(JSON.parse(optOut.stdout).via, 'tsx')
    }

    const wrapper = join(checkout, 'skills/claude/appjamat-v3/scripts/jamat-v3.mjs')

    // Newer file in lib-orchestrator/clientApi marks the bundle stale -> falls back to tsx.
    setTime(libSource, 10)
    const staleLib = spawnSync(process.execPath, [wrapper, 'status'],
      { encoding: 'utf8', windowsHide: true, cwd: checkout, timeout: 5000 })
    assert.equal(staleLib.status, 0, staleLib.stderr + staleLib.stdout)
    assert.equal(JSON.parse(staleLib.stdout).via, 'tsx')

    // Restore lib timestamp, touch app-client-cli/start.ts -> still stale -> tsx.
    setTime(libSource, -20)
    setTime(cliSource, 10)
    const staleCli = spawnSync(process.execPath, [wrapper, 'status'],
      { encoding: 'utf8', windowsHide: true, cwd: checkout, timeout: 5000 })
    assert.equal(staleCli.status, 0, staleCli.stderr + staleCli.stdout)
    assert.equal(JSON.parse(staleCli.stdout).via, 'tsx')

    // Missing bundle -> falls back to tsx.
    setTime(cliSource, -20)
    rmSync(devBundle)
    const missing = spawnSync(process.execPath, [wrapper, 'status'],
      { encoding: 'utf8', windowsHide: true, cwd: checkout, timeout: 5000 })
    assert.equal(missing.status, 0, missing.stderr + missing.stdout)
    assert.equal(JSON.parse(missing.stdout).via, 'tsx')
  } finally { rmSync(checkout, { recursive: true, force: true }) }
})
