import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { FinishUiReceipt } from '../release/finishUiReceipt.js'
import { SvnSmokeIsolation } from './svnSmokeIsolation.js'

async function run(): Promise<void> {
  const root = resolve(import.meta.dirname, '..', '..')
  let testRoot = tmpdir(), keep = false, skipKnownLimits = false
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--keep') keep = true
    else if (arg === '--skip-known-limits') skipKnownLimits = true
    else if (arg === '--test-root' && args[index + 1] && !args[index + 1].startsWith('--')) testRoot = args[++index]
    else throw new Error('Usage: worktreesAcceptance.ts [--test-root <directory>] [--keep] [--skip-known-limits]')
  }
  testRoot = await SvnSmokeIsolation.parent(testRoot)
  const tested = await FinishUiReceipt.hash(root)
  await execute(root, 'scripts/smoke/managedRunStop.ts', ['--test-root', testRoot])
  const fixtureArgs = ['--test-root', testRoot, ...(keep ? ['--keep'] : []), ...(skipKnownLimits ? ['--skip-known-limits'] : [])]
  // Default includes audit, preparation, update, scope and the Finish 072 incident; these add the larger
  // matrices, and moves, the E07/E08 recovery cases and the branch experiment, which the default skips.
  for (const selector of [undefined, '--matrix-changes', '--matrix-externals', '--matrix-conflicts', '--matrix-moves', '--matrix-recovery', '--matrix-branches'])
    await execute(root, 'scripts/smoke/svn-worktree.ts', [...(selector ? [selector] : []), ...fixtureArgs])
  await execute(root, 'scripts/smoke/ui.ts', ['finish', '--externals', '--test-root', testRoot])
  await execute(root, 'scripts/smoke/ui.ts', ['worktree-extensions', '--test-root', testRoot])
  if (skipKnownLimits) {
    if (await FinishUiReceipt.hash(root) !== tested) throw new Error('Sources changed during filtered acceptance')
    await writeFile(resolve(root, '.aidocs/temp/worktrees-acceptance-filtered.json'), JSON.stringify({
      hash: tested, passedAt: new Date().toISOString(), excluded: ['D10-unicode'], fullReleaseReceipt: false,
    }) + '\n')
    console.log('[worktrees-acceptance] Supported scenarios passed; D10-unicode skipped by request. This is not a complete release receipt.')
    return
  }
  await FinishUiReceipt.save(root, tested, true)
  await FinishUiReceipt.require(root)
  console.log('[worktrees-acceptance] All SVN matrices and Finish UI with externals passed for the same source bytes')
}

async function execute(root: string, script: string, args: string[]): Promise<void> {
  console.log(`[worktrees-acceptance] ${script} ${args.join(' ')}`)
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`${script} failed (${signal ?? code})`))
    })
  })
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
