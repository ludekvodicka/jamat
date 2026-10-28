import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FinishUiReceipt } from './finishUiReceipt.js'

test('Finish UI receipt binds pre-run source bytes, refuses missing/stale proof and never accepts edits during the scenario', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jamat-finish-receipt-'))
  try {
    for (const directory of ['lib-orchestrator/worktrees', 'lib-orchestrator/svn', 'lib-orchestrator/sessionManager', 'app-client-ui/renderer/sessionActions',
      'app-client-cli', 'app-host', 'app-codex', 'mdext-renderer', 'scripts', 'configs']) await mkdir(join(root, directory), { recursive: true })
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']) await writeFile(join(root, file), '{}')
    const driver = join(root, 'lib-orchestrator/worktrees/driver.ts')
    await writeFile(driver, 'original')
    await assert.rejects(FinishUiReceipt.require(root), /Run pnpm smoke:worktrees-acceptance first/)
    const tested = await FinishUiReceipt.hash(root)
    await FinishUiReceipt.save(root, tested)
    await assert.rejects(FinishUiReceipt.require(root), /Run pnpm smoke:worktrees-acceptance first/)
    await FinishUiReceipt.save(root, tested, true)
    await FinishUiReceipt.require(root)
    await writeFile(driver, 'edited')
    await assert.rejects(FinishUiReceipt.require(root), /Run pnpm smoke:worktrees-acceptance first/)
    await assert.rejects(FinishUiReceipt.save(root, tested), /changed during/)
    await writeFile(driver, 'original')
    await FinishUiReceipt.require(root)
    for (const file of ['lib-orchestrator/svn/added.ts', 'lib-orchestrator/sessionManager/added.ts', 'app-client-ui/electron.vite.config.ts',
      'app-client-cli/added.ts', 'app-host/added.ts', 'scripts/driver.ts', 'app-client-ui/renderer/sessionActions/added.tsx']) {
      await writeFile(join(root, file), 'new input')
      await assert.rejects(FinishUiReceipt.require(root), /Run pnpm smoke:worktrees-acceptance first/)
      await rm(join(root, file))
      await FinishUiReceipt.require(root)
    }
    await writeFile(join(root, FinishUiReceipt.relativePath), JSON.stringify({ version: 3, hash: tested, svnMatrices: true, externals: false, passedAt: 'today' }))
    await assert.rejects(FinishUiReceipt.require(root), /--externals/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
