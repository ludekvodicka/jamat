import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { app, dialog, Notification, session } from 'electron'

import { ChildEnvironment } from '../../lib-orchestrator/shared/childEnvironment'
import { AppClientUiReport } from '../shared/appClientUiReport'
import { AppConfig } from './appConfig'
import { AppContext } from './appContext'
import { MainHub } from './appHub'
import { ClientStatePaths } from './clientState/clientStatePaths'
import { FileViewerProtocol } from './fileViewer/fileViewerProtocol'
import { RelaunchMarker } from './processes/relaunchMarker'
import type { ChildProcessKind } from '../../lib-orchestrator/shared/processWire.types'

export class AppClientUi {
  /** Config is read before `whenReady`: a launch that cannot name its config directory has no window. */
  static async run(mainModuleUrl: string): Promise<void> {
    FileViewerProtocol.registerScheme()
    const config = AppConfig.load(app.isPackaged)
    const agentMarker = ChildEnvironment.agentSessionMarkerOf(process.env)
    if (agentMarker !== null)
      AppClientUiReport.warning(`started inside an agent session (${agentMarker} is set); `
        + 'its session variables are stripped from every session this client starts')
    // Electron resolves userData while it becomes ready, and caches it. An override applied after
    // `whenReady` moves the directory for later readers while the caches stay in the shared default
    // profile, which is keyed by neither config identity nor channel.
    app.setPath('userData', AppClientUi.stateDirectoryOf(config))
    // Taken after the redirect because the lock is keyed by userData, so it covers exactly one
    // {configIdentity, channel}. Two clients on one pair are two writers of one state file, each
    // holding its own cached document, and the last write wins.
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return
    }
    // Subscribed before ready, not after the hub exists: a second launch during this one's boot
    // would otherwise find no listener, quit, and leave the user looking at nothing happening.
    // Subscribing early is only half of it - until `whenReady` returns there is no window to focus,
    // so the request is REMEMBERED and answered once there is one. `hub?.focusWindow()` alone
    // silently dropped every launch that arrived during the boot it was written for.
    let hub: MainHub | null = null
    let focusRequested = false
    let readyForFocus = false
    app.on('second-instance', () => {
      if (hub && readyForFocus)
        hub.focusWindow()
      else
        focusRequested = true
    })
    // The id the installer's shortcut carries (`build.appId`): Windows shows a notification of this
    // process under it, and a click on it reaches this process.
    if (process.platform === 'win32') app.setAppUserModelId('com.jamat.app')
    await app.whenReady()
    const context = new AppContext(config, mainModuleUrl)
    // Vite serves optimized dependencies as immutable, and a later optimization can reuse the same
    // `?v=`. A profile that kept the older copy then mixes two builds of one package: vega lost its
    // transforms and Usage showed 'Unrecognized transform type: "formula"'. Only the dev server's
    // responses are cached this way; a packaged client loads its renderer from files.
    if (context.rendererDevUrl !== undefined)
      await session.defaultSession.clearCache()
    let drainStarted = false
    let drainDone = false
    const marker = new RelaunchMarker(join(AppClientUi.stateDirectoryOf(config), 'child-relaunch.json'))
    const drain = async (): Promise<void> => {
      drainStarted = true
      readyForFocus = false
      try {
        hub!.beginQuit()
        await hub!.dispose()
      } finally {
        drainDone = true
      }
    }
    const childExited = async (kind: ChildProcessKind): Promise<void> => {
      if (drainStarted) return
      const at = Date.now()
      // The synchronous latch also covers a sibling exiting while the first crash is draining.
      const drained = drain()
      try {
        const restart = marker.canRelaunch(at)
        if (restart)
          new Notification({ title: 'Jamat is restarting', body: `The ${kind} process stopped unexpectedly. Jamat will restart.` }).show()
        await drained
        if (restart) {
          marker.record(at)
          if (!await hub!.restart()) app.quit()
        } else {
          dialog.showErrorBox('Jamat stopped after repeated crashes',
            `The ${kind} process stopped again within 60 seconds. Automatic restart has stopped.`)
          app.quit()
        }
      } catch (error) {
        try { await drained } catch { /* report the original failure after cleanup */ }
        dialog.showErrorBox('Jamat could not restart', error instanceof Error ? error.message : String(error))
        app.quit()
      }
    }
    hub = new MainHub(context, kind => {
      void childExited(kind).catch(error => { AppClientUiReport.error(String(error)); app.exit() })
    })
    app.on('before-quit', event => {
      if (drainDone) return
      event.preventDefault()
      if (drainStarted) { app.exit(); return }
      void drain().catch(error => AppClientUiReport.error(String(error))).finally(() => app.quit())
    })
    try { await hub.initialize() }
    catch (error) {
      if (!drainStarted) {
        dialog.showErrorBox('Jamat could not start', error instanceof Error ? error.message : String(error))
        app.quit()
      }
      return
    }
    if (drainStarted) return
    readyForFocus = true
    if (focusRequested)
      hub.focusWindow()
    if (context.smoke && !context.smokeDriver)
      hub.runSmoke()
    app.on('window-all-closed', () => { if (!drainStarted) app.quit() })
  }

  /** Answered by the config alone, so it is available before Electron is ready and needs nothing from it. */
  private static stateDirectoryOf(config: AppConfig): string {
    const directory = ClientStatePaths.directory(
      config.identity.configIdentity,
      config.runtimeChannel,
    )
    mkdirSync(directory, { recursive: true })
    return directory
  }
}
