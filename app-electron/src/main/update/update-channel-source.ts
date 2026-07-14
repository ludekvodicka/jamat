/**
 * Source-checkout driver — the app runs over its own sources (dev run, or a packaged binary launched
 * by `bin/start.bat`, which sets `JAMAT_ROOT`).
 *
 * It runs NO VCS command and queries NO remote. It only compares the RUNNING build against the
 * sources ON DISK (root `package.json`, bumped by `npm run bump`) and offers a restart — the launcher
 * recompiles when the version changed, which is what actually loads the new code. Learning that a
 * newer version exists upstream is deliberately the human's job (`svn update` / their own commit);
 * the app just notices the disk moved.
 *
 * The prompt/snooze/idle rules live in the shared `prompt-gate` — the same ones the GitHub driver uses.
 */
import { join } from 'node:path'

import type { UpdateResolution } from '../../../../core/update/update-channel.js'
import { isNewerVersion, readPackageVersion } from '../../../../core/update/update-versions.js'
import { getAppVersion } from '../app-root'
import { relaunchApp } from '../relaunch'
import { onTabsChanged } from '../tab-tree-cache'
import { logInfo } from '../logger'
import { logUpdate } from './update-log'
import { createPromptGate } from './prompt-gate'
import { setLastCheck, setPendingVersion } from './update-state'

const INITIAL_DELAY_MS = 45_000

const gate = createPromptGate()
let started = false
let pendingVersion: string | null = null
let sourcePackageJson = ''

export function startSourceDriver(res: UpdateResolution): void {
  if (started) return
  started = true
  sourcePackageJson = join(res.monorepoRoot, 'package.json')

  if (!res.autoCheck) {
    logUpdate({ event: 'check', channel: 'source', reason: 'background checks disabled (selfUpdate.autoCheck=false) — the manual check still works' })
    return
  }

  const intervalMs = res.checkIntervalMinutes * 60 * 1000
  setTimeout(() => poll(), INITIAL_DELAY_MS)
  setInterval(() => poll(), intervalMs)
  onTabsChanged(() => offerIfPending())
  logInfo('update', `source driver: watching ${sourcePackageJson} every ${res.checkIntervalMinutes} min`)
}

/** Read the on-disk build version. Returns null when unreadable. */
export function diskVersion(monorepoRoot?: string): string | null {
  return readPackageVersion(monorepoRoot ? join(monorepoRoot, 'package.json') : sourcePackageJson)
}

/** Is the build on disk newer than the one running? Never throws (a scheme mismatch is logged). */
export function diskIsNewer(disk: string | null): boolean {
  if (!disk) return false
  try {
    return isNewerVersion(disk, getAppVersion())
  } catch (e) {
    // compareVersions throws on a datestamp-vs-semver mix — loud in the log, never a wrong "newer".
    logUpdate({ event: 'error', channel: 'source', detail: (e as Error).message })
    return false
  }
}

function poll(): void {
  const disk = diskVersion()
  const running = getAppVersion()
  const newer = diskIsNewer(disk)
  setLastCheck(newer ? `on-disk build ${disk} is newer than the running ${running}` : `running build matches the sources (${running})`)
  logUpdate({ event: 'check', channel: 'source', trigger: 'background', running, found: newer ? disk : null })
  pendingVersion = newer ? disk : null
  setPendingVersion(pendingVersion)
  offerIfPending()
}

function offerIfPending(): void {
  if (!pendingVersion) return
  const target = pendingVersion
  gate.offer({
    channel: 'source',
    version: target,
    title: 'Newer build on disk',
    message: `A newer build is on disk (${target}).`,
    idleDetail: `Running: ${getAppVersion()}\nOn disk: ${target}\n\nAll terminals are idle — restarting loads it (the launcher recompiles).`,
    actionLabel: 'Restart now',
    onAction: async () => {
      logUpdate({ event: 'relaunch', channel: 'source', found: target })
      await relaunchApp()
      pendingVersion = null
    },
  }, false)
}
