import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

class AppJamatV3SkillCli {
  static run() {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const bundled = resolve(repoRoot, 'cli/jamat-v3.cjs')
    const bundle = existsSync(bundled) ? bundled : AppJamatV3SkillCli.freshDevBundle(repoRoot)
    // The subprocess drops caller Node flags; keep that behavior when flags were supplied.
    if (bundle !== null && process.execArgv.length === 0) {
      process.argv[1] = bundle
      createRequire(import.meta.url)(bundle)
      return
    }
    const runner = resolve(repoRoot, 'app-client-cli/node_modules/tsx/dist/cli.mjs')
    const entry = resolve(repoRoot, 'app-client-cli/start.ts')
    // tsx otherwise reads the caller's tsconfig.json, whose paths can send 'ws' to a foreign CommonJS entry.
    const tsconfig = resolve(repoRoot, 'app-client-cli/tsconfig.json')
    const result = spawnSync(
      process.execPath,
      bundle !== null ? [bundle, ...process.argv.slice(2)]
        : [runner, '--tsconfig', tsconfig, entry, ...process.argv.slice(2)],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
    )
    if (result.error) {
      process.stderr.write(`AppJamatV3 CLI could not start: ${result.error.message}\n`)
      return 6
    }
    return result.status ?? 7
  }

  static freshDevBundle(repoRoot) {
    if (process.env.JAMAT_V3_CLI_NO_BUNDLE === '1') return null
    const devBundle = resolve(repoRoot, 'out/skills-bundle/cli/jamat-v3.cjs')
    let bundleMtimeMs
    try { bundleMtimeMs = statSync(devBundle).mtimeMs }
    catch { return null }
    for (const root of [resolve(repoRoot, 'app-client-cli'), resolve(repoRoot, 'lib-orchestrator')])
      if (AppJamatV3SkillCli.hasNewerSource(root, bundleMtimeMs)) return null
    return devBundle
  }

  static hasNewerSource(directory, thresholdMs) {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) }
    catch (error) { return !(error && typeof error === 'object' && error.code === 'ENOENT') }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name.startsWith('.')) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (AppJamatV3SkillCli.hasNewerSource(fullPath, thresholdMs)) return true
      } else if (entry.isFile() && AppJamatV3SkillCli.isSourceFile(entry.name)) {
        try {
          if (statSync(fullPath).mtimeMs > thresholdMs) return true
        } catch { return true }
      }
    }
    return false
  }

  static isSourceFile(name) {
    if (name.includes('.test.') || name.includes('.spec.')) return false
    return name.endsWith('.ts') || name.endsWith('.mts') || name.endsWith('.cts')
      || name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')
      || name === 'package.json' || name === 'tsconfig.json'
  }
}

const exitCode = AppJamatV3SkillCli.run()
if (exitCode !== undefined) process.exitCode = exitCode
