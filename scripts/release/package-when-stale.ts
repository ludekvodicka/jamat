import { resolve } from 'node:path'

import { ensurePackagedClient } from './localClientPackage.js'

async function run(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--print-executable'))
    throw new Error('usage: package-when-stale.ts [--print-executable]')
  const manifest = await ensurePackagedClient(resolve(import.meta.dirname, '..', '..'))
  if (args[0] === '--print-executable') console.log(manifest.executablePath)
}

void run().catch((error: unknown) => {
  console.error(`[package-when-stale] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
