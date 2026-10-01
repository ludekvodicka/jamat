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
}

export type AutolauncherResult =
  | { ok: true; snapshot: AutolauncherSnapshot }
  | { ok: false; problem: string }
