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
  readonly appVersion: string
  readonly fileDiffWorkerPath: string
  readonly preloadPath: string
  readonly rendererPath: string
  readonly rendererDevUrl: string | undefined
  /** The second document of the same renderer build, and the same dev server serving it. */
  readonly debugRendererPath: string
  readonly debugRendererDevUrl: string | undefined
  readonly appInfo: AppInfo

  constructor(readonly config: AppConfig, mainModuleUrl: string) {
    const outputMainDir = dirname(fileURLToPath(mainModuleUrl))
    this.appVersion = app.getVersion()
    this.fileDiffWorkerPath = join(outputMainDir, 'fileDiffWorker.js')
    this.preloadPath = join(outputMainDir, '../preload/index.js')
    this.rendererPath = join(outputMainDir, '../renderer/index.html')
    this.rendererDevUrl = process.env.ELECTRON_RENDERER_URL
    this.debugRendererPath = join(outputMainDir, '../renderer/debug.html')
    // Derived rather than a second variable: one dev server serves both documents, and electron-vite
    // publishes its address once.
    this.debugRendererDevUrl = this.rendererDevUrl
      ? new URL('debug.html', this.rendererDevUrl).toString()
      : undefined
    this.appInfo = {
      appVersion: this.appVersion,
      platform: process.platform,
      configDir: config.configDir,
      configIdentity: config.identity.configIdentity,
      runtimeChannel: config.runtimeChannel,
    }
  }
}
