import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

class AppJamatV3SkillCli {
  static run() {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const bundled = resolve(repoRoot, 'cli/jamat-v3.cjs')
    const runner = resolve(repoRoot, 'app-client-cli/node_modules/tsx/dist/cli.mjs')
    const entry = resolve(repoRoot, 'app-client-cli/start.ts')
    // tsx otherwise reads the caller's tsconfig.json, whose paths can send 'ws' to a foreign CommonJS entry.
    const tsconfig = resolve(repoRoot, 'app-client-cli/tsconfig.json')
    const result = spawnSync(
      process.execPath,
      existsSync(bundled) ? [bundled, ...process.argv.slice(2)]
        : [runner, '--tsconfig', tsconfig, entry, ...process.argv.slice(2)],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
    )
    if (result.error) {
      process.stderr.write(`AppJamatV3 CLI could not start: ${result.error.message}\n`)
      return 6
    }
    return result.status ?? 7
  }
}

process.exitCode = AppJamatV3SkillCli.run()
