import type { Plugin } from 'vite'
import { clientBuildInfo } from '../../scripts/release/clientBuildInfo'
import { prepareOrchestrator } from '../../scripts/release/prepare-orchestrator'
import { prepareGateway } from '../../scripts/release/prepare-gateway'
import { waitForRestartPredecessor } from './restartPredecessor'

export function gatewayBuildPlugin(root: string): Plugin {
  let identity = clientBuildInfo(root)
  return {
    name: 'jamat-gateway-build',
    enforce: 'pre',
    async buildStart() {
      await waitForRestartPredecessor()
      identity = clientBuildInfo(root)
      for (const paths of await Promise.all([prepareGateway(root, identity), prepareOrchestrator(root, identity)]))
        for (const path of paths) this.addWatchFile(path)
    },
    resolveId(id) { if (id === 'virtual:jamat-client-build') return '\0jamat-client-build' },
    load(id) { if (id === '\0jamat-client-build') return 'export default null' },
    shouldTransformCachedModule({ id }) { return id === '\0jamat-client-build' },
    transform(_code, id) { if (id === '\0jamat-client-build') return `export default ${JSON.stringify(identity)}` },
  }
}
