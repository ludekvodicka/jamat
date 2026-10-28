import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Usage build inputs', () => {
  it('registers the third renderer and third main input with their packaged paths', () => {
    const root = join(import.meta.dirname, '..')
    const config = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(config).toContain("tokenUsageWorker: resolve(__dirname, 'app/tokenUsage/tokenUsageWorkerEntry.ts')")
    expect(config).toContain("usage: resolve(__dirname, 'renderer/usage.html')")
    const context = readFileSync(join(root, 'app/appContext.ts'), 'utf8')
    expect(context).toContain("join(outputMainDir, 'tokenUsageWorker.js')")
    expect(context).toContain("join(outputMainDir, '../renderer/usage.html')")
    expect(readFileSync(join(root, 'renderer/usage.html'), 'utf8')).toContain('./usageWindow/usageMain.tsx')
    const inputs = readFileSync(join(root, '../scripts/release/localPackageInputs.ts'), 'utf8')
    expect(inputs).toContain("'app-client-ui/app'")
    expect(inputs).toContain("'app-client-ui/renderer'")
    expect(inputs).toContain("'lib-orchestrator'")
  })
})
