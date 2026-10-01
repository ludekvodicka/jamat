import type { AppConfig } from './appConfig'
import type { AppContext } from './appContext'
import { LauncherTarget } from './launcherTarget'
import { LauncherServer } from './launcherServer'
import { LocalTargetControl } from './localTargetControl'

export class AppHub {
  readonly listener: LauncherServer

  constructor(config: AppConfig, context: AppContext) {
    const control = new LocalTargetControl(config.configDir, config.identity)
    const target = new LauncherTarget(config.recipe, config.configDir, config.identity.runtimeChannel, control, context)
    this.listener = new LauncherServer(config.publicUrl, config.key, target)
  }
}
