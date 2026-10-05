import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function prepareCodex(root: string): Promise<void> {
  const output = resolve(root, 'out/codex')
  mkdirSync(output, {recursive: true})
  const result = await build({
    entryPoints: [resolve(root, 'app-codex/start.ts')], outfile: resolve(output, 'start.cjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning',
  })
  if (result.warnings.length > 0)
    throw new Error(`Codex bundle warnings: ${result.warnings.map(warning => warning.text).join('; ')}`)
  cpSync(resolve(root, 'app-codex/package.json'), resolve(output, 'package.json'))
  cpSync(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
  cpSync(resolve(root, 'lib-orchestrator/node_modules/ws/LICENSE'), resolve(output, 'WS-LICENSE.txt'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void prepareCodex(resolve(import.meta.dirname, '../..')).catch((error: unknown) => {
    console.error(`Codex bundle: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
