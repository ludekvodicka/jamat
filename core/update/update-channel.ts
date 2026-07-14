/**
 * THE update-channel decision — one pure function, the single source of truth.
 *
 * The channel follows the RUNTIME, never the config:
 *  - `installed` (packaged, no `JAMAT_ROOT`) → `github` — electron-updater against the Releases feed
 *    baked into `app-update.yml`. On darwin → `none`: the builds are unsigned and electron-updater
 *    refuses unsigned updates on mac.
 *  - anything else (dev run, or a packaged repo-in-place launch via `bin/start.bat`, which sets
 *    `JAMAT_ROOT`) → `source` — the app compares the RUNNING version against the sources ON DISK and
 *    offers a restart (the launcher recompiles). It runs no VCS command and queries no remote: the
 *    human updates the sources, the app only notices the disk changed.
 *
 * Config only tunes the knobs (`autoCheck`, `checkIntervalMinutes`). The old `provider`/`vcs`/
 * `repoPath` keys are dead: a config that still carries them loads fine and gets a warning — one of
 * them (`provider:'vcs'`, which the Settings tab used to write by default) silently disabled GitHub
 * updates on installed builds, which is exactly the class of bug this function exists to prevent.
 *
 * Pure, no electron — every runtime fact is passed in, so it is smoke-testable.
 */
import type { SelfUpdateConfig } from '../types/config.js'

export type UpdateChannel = 'github' | 'source' | 'none'

export interface UpdateResolutionInput {
  /** `app.isPackaged` */
  packaged: boolean
  /** `process.env['JAMAT_ROOT']` — set by bin/start.bat: a packaged binary running over the repo. */
  jamatRoot: string | undefined
  platform: NodeJS.Platform
  /** `getMonorepoRoot()` — where the source `package.json` lives in `source` mode. */
  monorepoRoot: string
  selfUpdate: SelfUpdateConfig | undefined
}

export interface UpdateResolution {
  channel: UpdateChannel
  /** Human-readable, MANDATORY — logged at boot and shown in Settings. There is no silent no-op. */
  reason: string
  /** Deprecated config keys found, etc. Shown in Settings + logged. */
  warnings: string[]
  autoCheck: boolean
  checkIntervalMinutes: number
  monorepoRoot: string
}

const DEFAULT_INTERVAL_MIN: Record<UpdateChannel, number> = {
  github: 120,  // network poll — a release lands rarely
  source: 15,   // a local file read — cheap enough to notice a rebuild quickly
  none: 0,
}

function deprecationWarnings(su: SelfUpdateConfig | undefined): string[] {
  if (!su) return []
  const warnings: string[] = []
  if (su.provider !== undefined)
    warnings.push(`selfUpdate.provider ("${su.provider}") is ignored — the channel follows the runtime.`)
  if (su.vcs !== undefined)
    warnings.push(`selfUpdate.vcs ("${su.vcs}") is ignored — the app no longer runs any VCS command.`)
  if (su.repoPath !== undefined)
    warnings.push('selfUpdate.repoPath is ignored — the app updates from GitHub (installed) or from the sources on disk.')
  return warnings
}

export function resolveUpdateChannel(input: UpdateResolutionInput): UpdateResolution {
  const { packaged, jamatRoot, platform, monorepoRoot, selfUpdate } = input
  const warnings = deprecationWarnings(selfUpdate)
  const installed = packaged && !jamatRoot

  let channel: UpdateChannel
  let reason: string
  if (installed && platform === 'darwin') {
    channel = 'none'
    reason = 'Installed macOS build — auto-update needs a signed + notarized app; update by downloading the new release.'
  } else if (installed) {
    channel = 'github'
    reason = 'Installed build — updates come from the GitHub Releases feed.'
  } else if (packaged) {
    channel = 'source'
    reason = `Packaged build launched over the sources (JAMAT_ROOT=${jamatRoot}) — the running build is compared to the sources on disk.`
  } else {
    channel = 'source'
    reason = 'Development run — the running build is compared to the sources on disk.'
  }

  const interval = selfUpdate?.checkIntervalMinutes
  return {
    channel,
    reason,
    warnings,
    autoCheck: selfUpdate?.autoCheck !== false,
    checkIntervalMinutes: interval && interval > 0 ? interval : DEFAULT_INTERVAL_MIN[channel],
    monorepoRoot,
  }
}
