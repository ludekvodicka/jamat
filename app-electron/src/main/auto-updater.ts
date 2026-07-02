/**
 * Public auto-update — electron-updater + GitHub Releases, PACKAGED builds only.
 *
 * Two update channels, chosen by `selfUpdate.provider`:
 *  - `'vcs'` (default, the OWNER): a source checkout updates via a VCS pull + relaunch
 *    (`update-checker.ts` / `self-update.ts`).
 *  - `'github'` (PUBLIC): a packaged installer has no repo to pull — it updates from the
 *    GitHub Releases feed baked into `app-update.yml` by electron-builder's `publish` config.
 *
 * No-ops unless provider === 'github' AND `app.isPackaged` (electron-updater cannot update an
 * unpacked dev run). A newer release downloads in the background (harmless), then — the same
 * idle-aware UX as the VCS checker — the restart-to-install is offered only once every tab is
 * idle, so it never interrupts a live Claude turn. `autoInstallOnAppQuit` covers a
 * snoozed-forever update (it lands on the next quit).
 *
 * v1 scope: Windows (NSIS) + Linux (AppImage). macOS auto-update needs a signed + notarized
 * build (electron-updater refuses unsigned updates on mac) — deferred; mac users update manually.
 */
import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getAppConfig } from './ipc-windows'
import { onTabsChanged, allTabsIdle } from './tab-tree-cache'
import { logError, logInfo } from './logger'

const INITIAL_DELAY_MS = 45_000          // let the app settle before the first network poll
const DEFAULT_INTERVAL_MIN = 120
const SNOOZE_HOURS = [1, 2, 4, 12]       // maps to the four "Snooze" buttons

let started = false
let prompting = false
let downloadedVersion: string | null = null // a release fully downloaded, waiting for an idle restart
let snoozeUntilMs = 0
let snoozeTimer: ReturnType<typeof setTimeout> | null = null

/** Start the GitHub-Releases auto-updater. No-op unless provider==='github' and the build is
 *  packaged (electron-updater can't self-update a dev run). Safe to call alongside
 *  `startUpdateChecker()` — each self-gates on `selfUpdate.provider`. */
export function startAutoUpdater(): void {
  if (started) return
  const su = getAppConfig()?.selfUpdate
  if (su?.provider !== 'github') return // the VCS self-pull checker handles 'vcs'/default
  if (!app.isPackaged) { logInfo('auto-updater', 'skipped — unpacked dev build (no self-update)'); return }
  if (su.autoCheck === false) { logInfo('auto-updater', 'disabled via selfUpdate.autoCheck=false'); return }
  started = true

  autoUpdater.autoDownload = true          // background bytes are harmless; only the RESTART disrupts
  autoUpdater.autoInstallOnAppQuit = true  // a snoozed-forever update still lands on the next quit
  autoUpdater.logger = {
    info: (m: unknown) => logInfo('auto-updater', String(m)),
    warn: (m: unknown) => logInfo('auto-updater', String(m)),
    error: (m: unknown) => logError('auto-updater', String(m)),
    debug: () => { /* too chatty */ },
  }

  autoUpdater.on('error', (e) => logError('auto-updater', e?.message ?? String(e)))
  autoUpdater.on('update-available', (info) => logInfo('auto-updater', `update available: ${info.version} — downloading`))
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    logInfo('auto-updater', `downloaded ${info.version} — will offer restart when idle`)
    maybePromptInstall()
  })

  const intervalMs = Math.max(1, su.checkIntervalMinutes ?? DEFAULT_INTERVAL_MIN) * 60 * 1000
  setTimeout(() => { void check(false) }, INITIAL_DELAY_MS)
  setInterval(() => { void check(false) }, intervalMs)
  // Offer the restart the moment everything goes idle (a tab finished its turn), not just on a timer.
  onTabsChanged(() => maybePromptInstall())
  logInfo('auto-updater', `enabled (GitHub Releases, every ${Math.round(intervalMs / 60000)} min)`)
}

/** Manual "Update & Restart" menu action in GitHub mode: surface a pending install, else check now. */
export async function checkForUpdatesManual(): Promise<void> {
  const su = getAppConfig()?.selfUpdate
  if (su?.provider !== 'github') return
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info', title: 'Check for updates', noLink: true,
      message: 'Auto-update runs in the packaged app only.',
      detail: 'This is a development build — pull the repo to update.',
    })
    return
  }
  if (downloadedVersion) { snoozeUntilMs = 0; maybePromptInstall(); return } // a manual click overrides snooze
  await check(true)
}

async function check(manual: boolean): Promise<void> {
  try {
    const r = await autoUpdater.checkForUpdates()
    const latest = r?.updateInfo?.version
    if (manual && (!latest || latest === app.getVersion())) {
      await dialog.showMessageBox({
        type: 'info', title: 'Check for updates', noLink: true,
        message: `Jamat is up to date (${app.getVersion()}).`,
      })
    }
  } catch (e) {
    logError('auto-updater', `check failed: ${(e as Error)?.message ?? String(e)}`)
    if (manual) {
      await dialog.showMessageBox({
        type: 'error', title: 'Check for updates', noLink: true,
        message: 'Could not check for updates.', detail: (e as Error)?.message ?? String(e),
      })
    }
  }
}

/** Offer the restart-to-install only when a download is ready, nothing else is prompting, the
 *  snooze window has passed, and every tab is idle. Called on download, on tab-idle, on snooze wake. */
function maybePromptInstall(): void {
  if (!downloadedVersion || prompting) return
  if (Date.now() < snoozeUntilMs) return
  if (!allTabsIdle()) return
  void promptInstall()
}

async function promptInstall(): Promise<void> {
  if (prompting || !downloadedVersion) return
  prompting = true
  const target = downloadedVersion
  try {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Update ready',
      message: `Jamat ${target} is ready to install.`,
      detail: `Currently running: ${app.getVersion()}\nNew version:    ${target}\n\nAll terminals are idle — restart now to finish the update.`,
      buttons: ['Restart & install', 'Snooze 1h', 'Snooze 2h', 'Snooze 4h', 'Snooze 12h'],
      defaultId: 0,
      cancelId: 1, // Esc / close ⇒ snooze 1h, never an accidental restart
      noLink: true,
    })
    if (response === 0) {
      logInfo('auto-updater', `installing ${target} (quitAndInstall)`)
      // Defer so this dialog's IPC settles before the app tears down for the installer.
      setImmediate(() => autoUpdater.quitAndInstall(false, true))
    } else {
      const hours = SNOOZE_HOURS[response - 1] ?? 1
      snoozeUntilMs = Date.now() + hours * 60 * 60 * 1000
      logInfo('auto-updater', `install of ${target} snoozed ${hours}h (still installs on next quit)`)
      scheduleSnoozeWake(hours * 60 * 60 * 1000)
    }
  } finally {
    prompting = false
  }
}

/** Re-offer the install right when a snooze window elapses (if idle by then). */
function scheduleSnoozeWake(ms: number): void {
  if (snoozeTimer) clearTimeout(snoozeTimer)
  snoozeTimer = setTimeout(() => { snoozeTimer = null; maybePromptInstall() }, ms + 1000)
}
