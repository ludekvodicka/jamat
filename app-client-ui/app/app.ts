import { mkdirSync } from 'node:fs'

import { app } from 'electron'

import { AppConfig } from './appConfig'
import { AppContext } from './appContext'
import { AppHub } from './appHub'
import { ClientStatePaths } from './clientState/clientStatePaths'
import { FileViewerProtocol } from './fileViewer/fileViewerProtocol'

export class AppClientUi {
  /** Config is read before `whenReady`: a launch that cannot name its config directory has no window. */
  static async run(mainModuleUrl: string): Promise<void> {
    FileViewerProtocol.registerScheme()
    const config = AppConfig.load(app.isPackaged)
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
    let hub: AppHub | null = null
    let focusRequested = false
    app.on('second-instance', () => {
      if (hub)
        hub.focusWindow()
      else
        focusRequested = true
    })
    await app.whenReady()
    const context = new AppContext(config, mainModuleUrl)
    hub = new AppHub(context)
    hub.initialize()
    if (focusRequested)
      hub.focusWindow()
    if (context.smoke)
      hub.runSmoke()
    app.on('window-all-closed', () => app.quit())
    // Best effort by design: disposing only detaches from the Host. Electron does not wait for a
    // promise here, and it does not need to - a client that never got to release its lease leaves it
    // to expire by TTL, and no PTY dies either way.
    app.on('before-quit', () => {
      hub?.beginQuit()
      void hub?.dispose()
    })
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
