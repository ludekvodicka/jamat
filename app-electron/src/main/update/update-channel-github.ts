/**
 * GitHub Releases driver (installed builds) — electron-updater against the feed baked into
 * `app-update.yml` by electron-builder's `publish` config.
 *
 * Consent comes FIRST: `autoDownload` is off, so a check only ever *finds* a release. The user is
 * asked (the in-app dialog), and only their yes starts the download — which then runs inside that same
 * dialog as a progress bar and rolls straight into the install. The reverse order (download silently,
 * ask afterwards) is what made a working update feel broken: the click was followed by 10–20 s of
 * nothing, because the visible work had already happened where nobody could see it.
 *
 * Locked UX (do NOT "fix" these back):
 *  - Nothing is fetched without the user's yes. 128 MB is not the app's call to make.
 *  - Background offers appear only when every tab is idle (`blocked` counts as BUSY on purpose — a
 *    restart must never drop an in-progress turn). Manual ones bypass that and list what would die.
 *  - `autoInstallOnAppQuit` stays on: an update the user ACCEPTED but whose install did not complete
 *    still lands on the next quit. It can no longer surprise anyone, since nothing downloads unasked.
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { UpdateResolution } from '../../../../core/update/update-channel.js'
import { onTabsChanged } from '../tab-tree-cache'
import { logError, logInfo } from '../logger'
import { logUpdate } from './update-log'
import { createPromptGate } from './prompt-gate'
import { setAvailable, setChecking, setDownloading, setError, setIdle, setInstalling, setLastCheck } from './update-state'

const INITIAL_DELAY_MS = 45_000 // let the app settle before the first network poll
/** Let the renderer paint "installing" before Electron tears the window down. */
const INSTALL_PAINT_MS = 250

type Trigger = 'background' | 'manual' | 'remote'

const gate = createPromptGate()
let started = false
/** The release the feed offers, once a check has found one. Cleared when it installs. */
let availableVersion: string | null = null
let downloading = false

export interface GithubCheckResult {
  version: string | null   // null = up to date
  error?: string
}

export function startGithubDriver(res: UpdateResolution): void {
  if (started) return
  started = true

  autoUpdater.autoDownload = false          // consent first — see the header
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m: unknown) => logInfo('auto-updater', String(m)),
    warn: (m: unknown) => logInfo('auto-updater', String(m)),
    error: (m: unknown) => logError('auto-updater', String(m)),
    debug: () => { /* too chatty */ },
  }

  autoUpdater.on('error', (e) => {
    const detail = e?.message ?? String(e)
    downloading = false
    setError(detail)
    logUpdate({ event: 'error', channel: 'github', detail })
  })
  autoUpdater.on('download-progress', (p) => {
    setDownloading({
      version: availableVersion ?? app.getVersion(),
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: Math.round(p.bytesPerSecond),
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloading = false
    logUpdate({ event: 'downloaded', channel: 'github', found: info.version })
    void install(info.version)
  })

  if (!res.autoCheck) {
    logUpdate({ event: 'check', channel: 'github', reason: 'background checks disabled (selfUpdate.autoCheck=false) — the manual check still works' })
    return
  }

  const intervalMs = res.checkIntervalMinutes * 60 * 1000
  setTimeout(() => { void check('background') }, INITIAL_DELAY_MS)
  setInterval(() => { void check('background') }, intervalMs)
  // Offer the moment everything goes idle (a tab finished its turn), not just on the next timer tick.
  onTabsChanged(() => offerIfAvailable(false))
  logInfo('update', `github driver: first check in ${INITIAL_DELAY_MS / 1000}s, then every ${res.checkIntervalMinutes} min`)
}

/** Ask the feed. Always logs the outcome; never throws. Downloads NOTHING. */
export async function check(trigger: Trigger): Promise<GithubCheckResult> {
  try {
    setChecking()
    const r = await autoUpdater.checkForUpdates()
    // `updateInfo.version` is the feed's latest REGARDLESS of direction — comparing it by hand
    // (`!== app.getVersion()`) reports "found" for a downgrade/prerelease/locally-newer build too.
    // Trust the updater's own verdict.
    const available = r?.isUpdateAvailable === true
    const latest = r?.updateInfo?.version ?? null
    setLastCheck(available ? `found ${latest}` : `up to date (${app.getVersion()})`)
    logUpdate({ event: 'check', channel: 'github', trigger, running: app.getVersion(), found: available ? latest : null })
    if (available && latest) {
      availableVersion = latest
      setAvailable(latest)
      // A manual check bypasses the idle gate — the user asked and is watching. A remote one must NOT
      // pop a dialog on someone else's screen (the conscious remote install goes through `consent()`).
      if (trigger !== 'remote') offerIfAvailable(trigger === 'manual')
    } else
      setIdle()
    return { version: available ? latest : null }
  } catch (e) {
    const error = (e as Error)?.message ?? String(e)
    setLastCheck(`failed: ${error}`)
    setError(error)
    logUpdate({ event: 'error', channel: 'github', trigger, detail: `check failed: ${error}` })
    return { version: null, error }
  }
}

export function pendingUpdate(): string | null {
  return availableVersion
}

/** The offer — background waits for idle, manual doesn't. Answering yes starts the download. */
export function offerIfAvailable(manual: boolean): boolean {
  if (!availableVersion || downloading) return false
  const target = availableVersion
  gate.offer({
    channel: 'github',
    version: target,
    running: app.getVersion(),
    actionLabel: 'Download & install',
    onAction: () => consent(),
  }, manual)
  return true
}

/**
 * The user said yes (dialog button, status-bar chip, or a remote install): fetch the release now. The
 * dialog follows `download-progress` from here, and `update-downloaded` hands over to the installer.
 */
export function consent(): void {
  if (!availableVersion || downloading) return
  downloading = true
  setDownloading({ version: availableVersion, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
  logUpdate({ event: 'download-start', channel: 'github', running: app.getVersion(), found: availableVersion })
  void autoUpdater.downloadUpdate().catch((e) => {
    downloading = false
    const detail = (e as Error)?.message ?? String(e)
    setError(detail)
    logUpdate({ event: 'error', channel: 'github', detail: `download failed: ${detail}` })
  })
}

/** Downloaded — show the install state long enough to be seen, then hand over to the installer. */
async function install(version: string): Promise<void> {
  setInstalling(version)
  logUpdate({ event: 'install', channel: 'github', found: version })
  await new Promise((r) => setTimeout(r, INSTALL_PAINT_MS))
  autoUpdater.quitAndInstall(false, true)
}
