import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBuildInfo } from './clientBuildInfo'
import type { PerfBuild } from '../../lib-orchestrator/perfMonitor/perfRecord.types'

export async function prepareOrchestrator(root: string, identity: PerfBuild = clientBuildInfo(root)): Promise<string[]> {
  const output = resolve(root, 'out/orchestrator')
  mkdirSync(output, { recursive: true })
  const result = await build({ entryPoints: {
      start: resolve(root, 'app-orchestrator/start.ts'),
      fileDiffWorker: resolve(root, 'app-orchestrator/app/fileChanges/diff/fileDiffWorkerEntry.ts'),
      tokenUsageWorker: resolve(root, 'app-orchestrator/app/tokenUsage/tokenUsageWorkerEntry.ts'),
      svnAssemblyWorker: resolve(root, 'app-orchestrator/app/worktrees/svnAssemblyWorkerEntry.ts'),
    }, outdir: output, outExtension: { '.js': '.cjs' },
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning', metafile: true,
    define: { __JAMAT_V3_BUILD__: JSON.stringify(identity) }, external: ['original-fs'] })
  if (result.warnings.length) throw new Error(`Orchestrator bundle warnings: ${result.warnings.map(value => value.text).join('; ')}`)
  cpSync(resolve(root, 'app-orchestrator/package.json'), resolve(output, 'package.json'))
  cpSync(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
  return Object.keys(result.metafile.inputs).map(path => resolve(path))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void prepareOrchestrator(resolve(import.meta.dirname, '../..')).catch((error: unknown) => {
    console.error(`Orchestrator bundle: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
