import type { GatewayParentPort } from './app/app'
import { GatewayApp } from './app/app'
import type { PerfBuild } from '../lib-orchestrator/perfMonitor/perfRecord.types'

declare const __JAMAT_V3_BUILD__: PerfBuild
const parent = (process as NodeJS.Process & { parentPort?: GatewayParentPort }).parentPort
if (!parent) throw new Error('Gateway requires an Electron utility parent')
new GatewayApp(parent, __JAMAT_V3_BUILD__, code => process.exit(code)).start()
