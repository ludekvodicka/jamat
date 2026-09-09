import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

class AppJamatV3SkillCli {
  static run() {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const runner = resolve(repoRoot, 'app-client-cli/node_modules/tsx/dist/cli.mjs')
    const entry = resolve(repoRoot, 'app-client-cli/start.ts')
    const result = spawnSync(
      process.execPath,
      [runner, entry, ...process.argv.slice(2)],
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
