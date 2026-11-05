import type { PerfBuild } from '../lib-orchestrator/perfMonitor/perfRecord.types'
import { OrchestratorApp, type OrchestratorParentPort } from './app/app'

declare const __JAMAT_V3_BUILD__: PerfBuild
const parent = (process as NodeJS.Process & { parentPort?: OrchestratorParentPort }).parentPort
if (!parent) throw new Error('Orchestrator requires an Electron utility parent')
new OrchestratorApp(parent, __JAMAT_V3_BUILD__, __dirname, code => process.exit(code)).start()
