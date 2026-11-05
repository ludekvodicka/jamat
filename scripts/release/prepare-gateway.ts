import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBuildInfo } from './clientBuildInfo'
import type { PerfBuild } from '../../lib-orchestrator/perfMonitor/perfRecord.types'

export async function prepareGateway(root: string, identity: PerfBuild = clientBuildInfo(root)): Promise<string[]> {
  const output = resolve(root, 'out/gateway')
  mkdirSync(output, { recursive: true })
  const result = await build({ entryPoints: [resolve(root, 'app-gateway/start.ts')], outfile: resolve(output, 'start.cjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning', metafile: true,
    define: { __JAMAT_V3_BUILD__: JSON.stringify(identity) }, external: ['original-fs'] })
  if (result.warnings.length) throw new Error(`Gateway bundle warnings: ${result.warnings.map(value => value.text).join('; ')}`)
  cpSync(resolve(root, 'app-gateway/package.json'), resolve(output, 'package.json'))
  cpSync(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
  return Object.keys(result.metafile.inputs).map(path => resolve(path))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void prepareGateway(resolve(import.meta.dirname, '../..')).catch((error: unknown) => {
    console.error(`Gateway bundle: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
