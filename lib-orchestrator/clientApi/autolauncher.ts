import type { RemoteLauncherRecipe } from '../remoteControl/remoteLauncherConfig'
import type { RemoteLauncherAvailability, RemoteLauncherProcess } from '../remoteControl/remoteLauncherProcess'

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

export interface AutolauncherPort {
  get(): Promise<AutolauncherSnapshot>
  inspect(recipe: unknown): Promise<AutolauncherTargetView>
  enable(invitation: unknown, selection?: unknown): Promise<AutolauncherResult>
  disable(): Promise<AutolauncherResult>
}
