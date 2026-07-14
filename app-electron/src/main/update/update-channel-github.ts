/**
 * GitHub Releases driver (installed builds) — electron-updater against the feed baked into
 * `app-update.yml` by electron-builder's `publish` config.
 *
 * Locked UX (do NOT "fix" these back):
 *  - `autoDownload` — bytes are harmless; only the RESTART disrupts.
 *  - `autoInstallOnAppQuit` — a snoozed-forever update still lands on the next quit.
 *  - Background install prompt only when every tab is idle (`blocked` counts as BUSY on purpose — a
 *    restart must never drop an in-progress turn).
 *  - Snooze is the dialog's `defaultId`/`cancelId`: the dialog can pop while the user is typing and a
 *    stray Enter would otherwise wipe a live session.
 *
 * What changed vs the old auto-updater.ts: every exit is LOGGED to the persistent update log (a
 * suppressed prompt records WHY, including which tabs were busy), and a MANUAL trigger bypasses the
 * idle gate — clicking "Check for Updates…" used to be able to do nothing visible at all.
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { UpdateResolution } from '../../../../core/update/update-channel.js'
import { onTabsChanged } from '../tab-tree-cache'
import { buildSessionList } from '../relaunch'
import { logError, logInfo } from '../logger'
import { logUpdate } from './update-log'
import { createPromptGate } from './prompt-gate'
import { setChecking, setDownloading, setError, setIdle, setLastCheck, setPendingVersion } from './update-state'

const INITIAL_DELAY_MS = 45_000 // let the app settle before the first network poll

type Trigger = 'background' | 'manual' | 'remote'

const gate = createPromptGate()
let started = false
let downloadedVersion: string | null = null
/** The trigger of the check currently talking to the feed — its events belong to it. */
let inFlightTrigger: Trigger = 'background'
/**
 * Which trigger STARTED the in-flight download. Only a MANUAL check earns a gate-bypassing prompt:
 * the user asked and is watching. It must not be a "last check wins" flag — a background check landing
 * between the manual one and the download completing would downgrade the manual prompt back to
 * idle-gated, i.e. the click would again do nothing visible. A REMOTE check must NOT bypass either:
 * that would pop a dialog on someone else's screen mid-turn (the conscious remote install goes through
 * `installNow()` instead).
 */
let downloadTrigger: Trigger = 'background'
/** A download owns its trigger until it ends — a later check must not re-label it (see downloadTrigger). */
let downloading = false
/** The version being downloaded — `download-progress` events don't carry it. */
let inFlightVersion: string | null = null

export interface GithubCheckResult {
  version: string | null   // null = up to date
  error?: string
}

export function startGithubDriver(res: UpdateResolution): void {
  if (started) return
  started = true

  autoUpdater.autoDownload = true
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
    logUpdate({ event: 'error', channel: 'github', trigger: downloadTrigger, detail })
  })
  autoUpdater.on('update-available', (info) => {
    // The download starts HERE (autoDownload), inside the checkForUpdates() call — so the trigger must
    // already be known: reading it after the await would mis-file a manual download as background.
    if (!downloading) { downloadTrigger = inFlightTrigger; downloading = true }
    inFlightVersion = info.version
    setDownloading({ version: info.version, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
    logUpdate({ event: 'download-start', channel: 'github', trigger: downloadTrigger, running: app.getVersion(), found: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    setDownloading({
      version: downloadedVersion ?? inFlightVersion ?? app.getVersion(),
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: Math.round(p.bytesPerSecond),
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    downloading = false
    setPendingVersion(info.version)
    logUpdate({ event: 'downloaded', channel: 'github', trigger: downloadTrigger, found: info.version })
    // The MANUAL check that started this download gets its prompt now (the user is watching); a
    // background or remote one waits for idle. Either way the outcome is logged — and the status bar
    // shows the "New version ready" button regardless of what the gate decides.
    maybePromptInstall(downloadTrigger === 'manual')
  })

  if (!res.autoCheck) {
    logUpdate({ event: 'check', channel: 'github', reason: 'background checks disabled (selfUpdate.autoCheck=false) — the manual check still works' })
    return
  }

  const intervalMs = res.checkIntervalMinutes * 60 * 1000
  setTimeout(() => { void check('background') }, INITIAL_DELAY_MS)
  setInterval(() => { void check('background') }, intervalMs)
  // Offer the restart the moment everything goes idle (a tab finished its turn), not just on a timer.
  onTabsChanged(() => maybePromptInstall(false))
  logInfo('update', `github driver: first check in ${INITIAL_DELAY_MS / 1000}s, then every ${res.checkIntervalMinutes} min`)
}

/** Ask the feed. Always logs the outcome; never throws. */
export async function check(trigger: Trigger): Promise<GithubCheckResult> {
  try {
    inFlightTrigger = trigger
    setChecking()
    const r = await autoUpdater.checkForUpdates()
    // `updateInfo.version` is the feed's latest REGARDLESS of direction — comparing it by hand (`!==
    // app.getVersion()`) reports "found" for a downgrade/prerelease/locally-newer build too, and then
    // electron-updater downloads nothing (allowDowngrade=false) and never fires `update-downloaded`:
    // the user sees "Downloading X…" followed by silence forever. Trust the updater's own verdict.
    const available = r?.isUpdateAvailable === true
    const latest = r?.updateInfo?.version ?? null
    setLastCheck(available ? `found ${latest}` : `up to date (${app.getVersion()})`)
    logUpdate({ event: 'check', channel: 'github', trigger, running: app.getVersion(), found: available ? latest : null })
    if (!available) setIdle()   // the `update-available` handler owns the found case (it starts the download)
    return { version: available ? latest : null }
  } catch (e) {
    const error = (e as Error)?.message ?? String(e)
    setLastCheck(`failed: ${error}`)
    setError(error)
    logUpdate({ event: 'error', channel: 'github', trigger, detail: `check failed: ${error}` })
    return { version: null, error }
  }
}

export function pendingDownload(): string | null {
  return downloadedVersion
}

/** Install the pending download right now (used by the remote/headless path — a conscious act). */
export function installNow(trigger: 'manual' | 'remote'): void {
  if (!downloadedVersion) return
  logUpdate({ event: 'install', channel: 'github', trigger, found: downloadedVersion, detail: buildSessionList() })
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

/** Offer the restart-to-install through the shared gate (background: idle + un-snoozed; manual: now). */
export function maybePromptInstall(manual: boolean): void {
  if (!downloadedVersion) return
  const target = downloadedVersion
  gate.offer({
    channel: 'github',
    version: target,
    title: 'Update ready',
    message: `Jamat ${target} is ready to install.`,
    idleDetail: `Currently running: ${app.getVersion()}\nNew version:    ${target}\n\nAll terminals are idle — restart now to finish the update.`,
    actionLabel: 'Restart & install',
    onAction: () => {
      logUpdate({ event: 'install', channel: 'github', found: target })
      // Defer so the dialog's IPC settles before the app tears down for the installer.
      setImmediate(() => autoUpdater.quitAndInstall(false, true))
    },
  }, manual)
}
