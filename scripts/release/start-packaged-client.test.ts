import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'

import { LocalClientPackage } from './localClientPackage.js'
import { startPackagedClient } from './start-packaged-client.js'

test('source startup launches the selected executable with its profile, then refuses a failed build', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'jamat packaged start '))
  const saved = { ...process.env }
  try {
    const executablePath = join(root, process.platform === 'win32' ? 'Jamat with spaces.exe' : 'Jamat with spaces')
    copyFileSync(process.execPath, executablePath)
    const output = join(root, 'child.json')
    const hook = join(root, 'observe child.cjs')
    writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({
      cwd: process.cwd(), config: process.env.JAMAT_V3_CONFIG_DIR,
      channel: process.env.JAMAT_V3_RUNTIME_CHANNEL, electron: process.env.ELECTRON_RUN_AS_NODE,
      renderer: process.env.ELECTRON_RENDERER_URL, source: process.env.JAMAT_V3_SOURCE_CHECKOUT
    })); process.exit(0)`)
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(hook.replaceAll('\\', '/'))}`
    process.env.JAMAT_V3_CONFIG_DIR = join(root, 'profile with spaces')
    process.env.JAMAT_V3_RUNTIME_CHANNEL = 'development'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    let failBuild = false
    context.mock.method(LocalClientPackage.prototype, 'ensure', async () => {
      if (failBuild) throw new Error('compiler failed')
      return { schemaVersion: 1, inputHash: 'f'.repeat(64), executablePath, builtAt: new Date().toISOString() }
    })
    await startPackagedClient(root)
    const deadline = Date.now() + 10_000
    while (!existsSync(output) && Date.now() < deadline) await setTimeout(25)
    assert.equal(existsSync(output), true, 'the detached executable must run')
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      cwd: root, config: join(root, 'profile with spaces'), channel: 'development', source: root,
    })
    rmSync(output)
    failBuild = true
    await assert.rejects(startPackagedClient(root), /compiler failed/)
    assert.equal(existsSync(output), false)
  } finally {
    process.env = saved
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('source startup reports failure to spawn the selected executable', async (context) => {
  context.mock.method(LocalClientPackage.prototype, 'ensure', async () => ({
    schemaVersion: 1, inputHash: 'f'.repeat(64), builtAt: new Date().toISOString(),
    executablePath: join(tmpdir(), 'jamat absent executable', 'Jamat.exe'),
  }))
  await assert.rejects(startPackagedClient(tmpdir()), { code: 'ENOENT' })
})
