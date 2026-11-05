import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Usage build inputs', () => {
  it('builds Usage into the workspace document and the token worker at its development and packaged paths', () => {
    const root = join(import.meta.dirname, '..')
    const config = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(config).not.toContain('tokenUsageWorker:')
    const workerBuild = readFileSync(join(root, '../scripts/release/prepare-orchestrator.ts'), 'utf8')
    expect(workerBuild).toContain("tokenUsageWorker: resolve(root, 'app-orchestrator/app/tokenUsage/tokenUsageWorkerEntry.ts')")
    expect(workerBuild).toContain("outExtension: { '.js': '.cjs' }")
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).build.extraResources)
      .toContainEqual({ from: '../out/orchestrator', to: 'orchestrator', filter: ['**/*'] })
    expect(config).not.toContain('usage.html')
    const context = readFileSync(join(root, 'app/appContext.ts'), 'utf8')
    const utilityContext = readFileSync(join(root, '../app-orchestrator/app/appContext.ts'), 'utf8')
    expect(utilityContext).toContain("join(bundleDirectory, 'tokenUsageWorker.cjs')")
    expect(context).toContain("join(process.resourcesPath, 'orchestrator', 'start.cjs')")
    expect(readFileSync(join(root, 'renderer/shell/appShell.tsx'), 'utf8')).toContain("from '../usage/usagePanel'")
    const inputs = readFileSync(join(root, '../scripts/release/localPackageInputs.ts'), 'utf8')
    expect(inputs).toContain("'app-client-ui/app'")
    expect(inputs).toContain("'app-client-ui/renderer'")
    expect(inputs).toContain("'lib-orchestrator'")
  })
})
