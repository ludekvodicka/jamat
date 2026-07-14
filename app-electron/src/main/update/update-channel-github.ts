/**
 * GitHub Releases driver (installed builds) — electron-updater against the feed baked into
 * `app-update.yml` by electron-builder's `publish` config.
 *
 * Consent comes FIRST: `autoDownload` is off, so a check only ever *finds* a release. The user is
 * asked (the in-app dialog), and only their yes starts the download — which then runs inside that same
 * dialog as a progress bar. The full story of why the order is this way lives in the update-module ADR.
 *
 * Locked UX (do NOT "fix" these back):
 *  - Nothing is fetched without the user's yes. 128 MB is not the app's call to make.
 *  - Consent is NOT a blank cheque for the restart. A download takes minutes; by the time it lands the
 *    user may be mid-turn, so `update-downloaded` re-checks that every tab is idle and otherwise parks
 *    in `ready` until they are (`blocked` counts as BUSY on purpose — a restart must never drop an
 *    in-progress turn). Manual offers bypass the idle wait and list what would die.
 *  - `autoInstallOnAppQuit` stays on: an accepted-but-not-installed update still lands on the next
 *    quit. It can no longer surprise anyone, since nothing downloads unasked.
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { UpdateResolution } from '../../../../core/update/update-channel.js'
import { allTabsIdle, onTabsChanged } from '../tab-tree-cache'
import { logError, logInfo } from '../logger'
import { logUpdate } from './update-log'
import { createPromptGate } from './prompt-gate'
import { setAvailable, setChecking, setDownloading, setError, setIdle, setInstalling, setLastCheck, setReady } from './update-state'

const INITIAL_DELAY_MS = 45_000 // let the app settle before the first network poll
/** Let the renderer paint "installing" before Electron tears the window down. */
const INSTALL_PAINT_MS = 250

type Trigger = 'background' | 'manual' | 'remote'

const gate = createPromptGate()
let started = false
/** The release the feed offers. Reset by every check — a stale value would offer a yanked release. */
let availableVersion: string | null = null
/** Set once the bytes are on disk and the install is only waiting for an idle moment. */
let downloadedVersion: string | null = null
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
    // This handler fires for CHECK failures too (checkForUpdates emits AND rejects). A background
    // check that fails mid-download must not clear `downloading` or paint "Update failed" over a
    // healthy download — check() reports its own failures.
    if (!downloading) { logUpdate({ event: 'error', channel: 'github', detail }); return }
    downloading = false
    setError(detail)
    logUpdate({ event: 'error', channel: 'github', detail: `download failed: ${detail}` })
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
    downloadedVersion = info.version
    logUpdate({ event: 'downloaded', channel: 'github', found: info.version })
    // Consent was given when the download STARTED; minutes may have passed. Only quit if nothing is
    // working — otherwise park and offer the restart the moment everything goes idle.
    if (allTabsIdle()) { void install(info.version); return }
    setReady(info.version)
    offerRestart(false)
  })

  if (!res.autoCheck) {
    logUpdate({ event: 'check', channel: 'github', reason: 'background checks disabled (selfUpdate.autoCheck=false) — the manual check still works' })
    return
  }

  const intervalMs = res.checkIntervalMinutes * 60 * 1000
  setTimeout(() => { void check('background') }, INITIAL_DELAY_MS)
  setInterval(() => { void check('background') }, intervalMs)
  // Offer the moment everything goes idle (a tab finished its turn), not just on the next timer tick.
  onTabsChanged(() => { if (downloadedVersion) offerRestart(false); else offerIfAvailable(false) })
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
    availableVersion = available ? latest : null
    if (availableVersion) {
      setAvailable(availableVersion)
      // A manual check bypasses the idle gate — the user asked and is watching. A remote one must NOT
      // pop a dialog on someone else's screen (the conscious remote install goes through `consent()`).
      if (trigger !== 'remote') offerIfAvailable(trigger === 'manual')
    } else
      setIdle()
    return { version: availableVersion }
  } catch (e) {
    const error = (e as Error)?.message ?? String(e)
    setLastCheck(`failed: ${error}`)
    // A background poll that failed is not a user-visible failure — it must not paint the chip red.
    if (trigger !== 'background') setError(error)
    logUpdate({ event: 'error', channel: 'github', trigger, detail: `check failed: ${error}` })
    return { version: null, error }
  }
}

/** The release found by the last check (null = up to date). */
export function pendingUpdate(): string | null {
  return availableVersion
}

/** The release already on disk, waiting for an idle moment to install. */
export function pendingInstall(): string | null {
  return downloadedVersion
}

export function isDownloading(): boolean {
  return downloading
}

/** The offer — background waits for idle, manual doesn't. Answering yes starts the download. */
export function offerIfAvailable(manual: boolean): boolean {
  if (!availableVersion || downloading || downloadedVersion) return false
  const target = availableVersion
  // The dialog renders the offer from the prompt, but the phase must agree — a stale `error` or `idle`
  // phase would otherwise show a body with no answer buttons and wedge the gate.
  setAvailable(target)
  gate.offer({
    channel: 'github',
    version: target,
    running: app.getVersion(),
    actionLabel: 'Download & install',
    onAction: () => consent(),
  }, manual)
  return true
}

/** Downloaded already — the only thing left is the restart. */
export function offerRestart(manual: boolean): boolean {
  if (!downloadedVersion) return false
  const target = downloadedVersion
  setReady(target)
  gate.offer({
    channel: 'github',
    version: target,
    running: app.getVersion(),
    actionLabel: 'Restart & install',
    onAction: () => install(target),
  }, manual)
  return true
}

/**
 * The user said yes (dialog button, status-bar chip, or a remote install): fetch the release now. The
 * dialog follows `download-progress` from here, and `update-downloaded` takes it from there.
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

/** Show the install state long enough to be seen, then hand over to the installer. */
async function install(version: string): Promise<void> {
  setInstalling(version)
  logUpdate({ event: 'install', channel: 'github', found: version, detail: allTabsIdle() ? undefined : 'busy terminals accepted by the user' })
  await new Promise((r) => setTimeout(r, INSTALL_PAINT_MS))
  autoUpdater.quitAndInstall(false, true)
}
