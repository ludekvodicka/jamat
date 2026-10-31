import type { RemoteLauncherRecipe } from '../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import type { RemoteLauncherAvailability, RemoteLauncherProcess } from '../../lib-orchestrator/remoteControl/remoteLauncherProcess'

export interface AutolauncherTargetView {
  recipe: RemoteLauncherRecipe | null
  process: RemoteLauncherProcess | null
  availability: RemoteLauncherAvailability
  warning: string | null
}

export interface AutolauncherSelection {
  recipe: RemoteLauncherRecipe
  temporaryPathConfirmed: boolean
}

export interface AutolauncherSnapshot {
  supported: boolean
  target: {
    configDir: string
    configIdentity: string
    runtimeChannel: 'development' | 'production'
    mode: 'executable' | 'source'
    path: string
  }
  installed: boolean
  installedForThisProfile: boolean
  installedConfigDir: string | null
  running: boolean
  connectionReady: boolean
  launcherUrl: string | null
  operation: 'idle' | 'installing' | 'removing'
  problem: string | null
  currentTarget: AutolauncherTargetView
  installedTarget: AutolauncherTargetView | null
}

export type AutolauncherResult =
  | { ok: true; snapshot: AutolauncherSnapshot }
  | { ok: false; problem: string }
