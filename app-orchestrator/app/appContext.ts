import { join } from 'node:path'
import type { OrchestratorBootstrap, OrchestratorRuntime } from '../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { PerfBuild } from '../../lib-orchestrator/perfMonitor/perfRecord.types'

export class OrchestratorAppContext {
  readonly runtime: OrchestratorRuntime
  constructor(bootstrap: OrchestratorBootstrap, build: PerfBuild, bundleDirectory: string) {
    const { shell: _shell, ...facts } = bootstrap
    this.runtime = { ...facts, build,
      fileDiffWorkerPath: join(bundleDirectory, 'fileDiffWorker.cjs'),
      tokenUsageWorkerPath: join(bundleDirectory, 'tokenUsageWorker.cjs'),
      svnAssemblyWorkerPath: join(bundleDirectory, 'svnAssemblyWorker.cjs'),
    }
  }
}
