import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

import type { AppInfo } from '../shared/appClientUiIpc'
import type { AppConfig } from './appConfig'

/** Built after `whenReady`; everything that must happen before it lives in `app.ts`. */
export class AppContext {
  /**
   * Read once here rather than wherever it is needed: a smoke run proves this composition boots, and
   * it must reach nothing outside its own process while doing it - the Host auto-start above all,
   * which would otherwise spawn a detached Host against the developer's own machine.
   */
  readonly smoke = process.argv.includes('--smoke')
  readonly smokeDriver: boolean
  /** `JAMAT_V3_LOCAL_STATE_DIR` names the state root: a measuring or test copy, which leaves the global skill links alone. */
  readonly privateStateRoot: boolean
  readonly appVersion: string
  readonly orchestratorBundlePath: string
  readonly preloadPath: string
  readonly rendererPath: string
  readonly rendererDevUrl: string | undefined
  readonly appInfo: AppInfo
  readonly gatewayBundlePath: string
  readonly config: AppConfig

  constructor(config: AppConfig, mainModuleUrl: string) {
    this.config = config
    this.smokeDriver = this.smoke && process.argv.includes('--smoke-driver')
    const outputMainDir = dirname(fileURLToPath(mainModuleUrl))
    this.privateStateRoot = Boolean(process.env.JAMAT_V3_LOCAL_STATE_DIR)
    this.appVersion = app.getVersion()
    this.gatewayBundlePath = app.isPackaged ? join(process.resourcesPath, 'gateway', 'start.cjs')
      : join(app.getAppPath(), '..', 'out', 'gateway', 'start.cjs')
    this.orchestratorBundlePath = app.isPackaged ? join(process.resourcesPath, 'orchestrator', 'start.cjs')
      : join(app.getAppPath(), '..', 'out', 'orchestrator', 'start.cjs')
    this.preloadPath = join(outputMainDir, '../preload/index.js')
    this.rendererPath = join(outputMainDir, '../renderer/index.html')
    this.rendererDevUrl = process.env.ELECTRON_RENDERER_URL
    this.appInfo = {
      appVersion: this.appVersion,
      platform: process.platform,
      configDir: config.configDir,
      configIdentity: config.identity.configIdentity,
      runtimeChannel: config.runtimeChannel,
    }
  }
}
