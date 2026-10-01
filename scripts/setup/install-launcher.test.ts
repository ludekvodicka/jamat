import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('Windows launcher setup preserves ownership and rolls back only before startup commit', {
  skip: process.platform !== 'win32',
}, () => {
  const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(import.meta.dirname, 'install-launcher.test.ps1'),
  ], { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.stdout.split('PASS ').length - 1, 11)
})

test('Windows launcher setup refuses an alternate account before elevation or installation', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'jamat setup result '))
  try {
    const destination = join(directory, 'not installed')
    const resultFile = join(directory, 'result.json')
    const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(import.meta.dirname, 'install-launcher.ps1'), '-Action', 'Disable', '-Destination', destination,
      '-ExpectedUserSid', 'S-1-0-0', '-ExpectedConfigIdentity', 'test-profile', '-ResultFile', resultFile,
    ], { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
      ok: false, problem: 'Approve Windows setup using the same Windows account as Jamat.',
    })
    assert.equal(existsSync(destination), false)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
