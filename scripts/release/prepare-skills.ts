import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function prepareSkills(root: string, output = resolve(root, 'out/skills-bundle')): Promise<void> {
  mkdirSync(resolve(output, 'cli'), { recursive: true })
  const result = await build({
    entryPoints: [resolve(root, 'app-client-cli/start.ts')],
    outfile: resolve(output, 'cli/jamat-v3.cjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning',
  })
  if (result.warnings.length)
    throw new Error(`skill CLI bundle warnings: ${result.warnings.map(warning => warning.text).join('; ')}`)
  for (const agent of ['claude', 'codex'])
    cpSync(resolve(root, 'skills', agent), resolve(output, 'skills', agent), { recursive: true })
  mkdirSync(resolve(output, 'mdext-renderer'), { recursive: true })
  for (const name of ['USAGE.md', 'reference.md', 'svg-style.md', 'examples'])
    cpSync(resolve(root, 'mdext-renderer', name), resolve(output, 'mdext-renderer', name), { recursive: true })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void prepareSkills(resolve(import.meta.dirname, '../..')).catch((error: unknown) => {
    console.error(`[release:skills] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
