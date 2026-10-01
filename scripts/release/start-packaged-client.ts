import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ChildEnvironment } from '../../lib-orchestrator/shared/childEnvironment.js'
import { ensurePackagedClient } from './localClientPackage.js'

export async function startPackagedClient(repositoryRoot: string): Promise<void> {
  const manifest = await ensurePackagedClient(repositoryRoot)
  const child = spawn(manifest.executablePath, [], {
    cwd: dirname(manifest.executablePath),
    env: { ...ChildEnvironment.keepingJamat(process.env), JAMAT_V3_SOURCE_CHECKOUT: repositoryRoot },
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  await new Promise<void>((accept, reject) => {
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); accept() })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void startPackagedClient(resolve(import.meta.dirname, '../..')).catch((error: unknown) => {
    console.error(`[start-packaged-client] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
