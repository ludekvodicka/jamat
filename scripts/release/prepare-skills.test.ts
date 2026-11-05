import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    for (const agent of ['claude', 'codex']) {
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
      assert.deepEqual(JSON.parse(helper.stdout), { ok: true, value: { group: 'completed', color: 'green' } })
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
    for (const agent of ['claude', 'codex']) {
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
  } finally { rmSync(output, { recursive: true, force: true }) }
})
