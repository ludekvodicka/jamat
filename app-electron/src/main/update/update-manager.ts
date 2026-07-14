/**
 * The update module's owner. One boot resolution → exactly one driver; one manual action that ALWAYS
 * ends in a dialog; one headless entry point for the remote path (`debug:update` → agent `/api/update`).
 *
 * The channel is decided by `resolveUpdateChannel()` (pure, in core/) — config cannot pick it. Every
 * outcome, including "nothing happened and here is why", lands in the persistent update log.
 */
import { app, dialog } from 'electron'

import { resolveUpdateChannel, type UpdateResolution } from '../../../../core/update/update-channel.js'
import { getAppConfig } from '../ipc-windows'
import { getAppVersion, getMonorepoRoot } from '../app-root'
import { buildSessionList, relaunchApp } from '../relaunch'
import { registerHandler } from '../../shared/typed-ipc'
import { logUpdate } from './update-log'
import { resolveChoice } from './prompt-gate'
import { getUpdateStatus, setBootResolution, setCurrentResolution, type UpdateStatus } from './update-state'
import * as github from './update-channel-github'
import * as source from './update-channel-source'

export { getUpdateStatus, type UpdateStatus }

/** Settings → Updates, the status-bar chip and the update dialog: read status, check, consent, answer. */
export function registerUpdateIpc(): void {
  registerHandler('update:status', async () => { resolve(); return getUpdateStatus() })
  // Fire-and-forget: the dialog/progress comes from main, so the renderer only needs to know the call
  // landed. The catch matters — this is the one path whose contract is "always ends visibly", so a
  // failure must reach the log instead of dying as an unhandled rejection.
  registerHandler('update:check', async () => {
    void checkForUpdatesManual().catch((e) => logUpdate({ event: 'error', trigger: 'manual', detail: (e as Error)?.message ?? String(e) }))
    return { ok: true }
  })
  registerHandler('update:install', async () => installPending())
  registerHandler('update:choice', async (_e, choice) => { resolveChoice(choice); return { ok: true } })
}

/**
 * The user consented in the dialog's no-prompt path (opened from the chip). It skips the offer and goes
 * straight to the work — the dialog already showed the busy terminals, which it reads from
 * `UpdateStatus.busy`. github: download → install, or the restart alone when the bytes are on disk.
 */
export async function installPending(): Promise<{ ok: boolean; error?: string }> {
  const res = resolve()
  if (res.channel === 'github') {
    if (github.pendingInstall()) { github.offerRestart(true); return { ok: true } }
    if (!github.pendingUpdate()) return { ok: false, error: 'No update has been found yet.' }
    github.consent()
    return { ok: true }
  }
  if (res.channel === 'source') {
    if (!source.offerIfPending(true)) return { ok: false, error: 'The running build already matches the sources on disk.' }
    return { ok: true }
  }
  if (res.channel === 'none') return { ok: false, error: res.reason }
  throw new Error(`Unknown update channel: ${JSON.stringify(res)}`)
}

function runtimeInput() {
  return {
    packaged: app.isPackaged,
    jamatRoot: process.env['JAMAT_ROOT'],
    platform: process.platform,
    monorepoRoot: getMonorepoRoot(),
    selfUpdate: getAppConfig()?.selfUpdate,
  }
}

/** Resolve fresh from the CURRENT config (manual actions must see a just-saved settings change). */
function resolve(): UpdateResolution {
  const res = resolveUpdateChannel(runtimeInput())
  setCurrentResolution(res)
  return res
}

export function startUpdateManager(): void {
  const res = resolveUpdateChannel(runtimeInput())
  setBootResolution(res)
  logUpdate({
    event: 'boot-resolution',
    channel: res.channel,
    running: getAppVersion(),
    reason: res.reason,
    detail: res.warnings.join(' ') || undefined,
  })
  if (res.channel === 'github') github.startGithubDriver(res)
  else if (res.channel === 'source') source.startSourceDriver(res)
  else if (res.channel === 'none') logUpdate({ event: 'channel-none', channel: 'none', reason: res.reason })
  else
    throw new Error(`Unknown update channel: ${JSON.stringify(res)}`)
}

async function info(message: string, detail?: string): Promise<void> {
  await dialog.showMessageBox({ type: 'info', title: 'Updates', message, detail })
}

/**
 * The menu action / Settings "Check now". A conscious act, so: it re-resolves from the current config,
 * it BYPASSES the idle gate (the offer lists the terminals a restart would kill instead of silently
 * doing nothing), and it never ends in silence — a release that is found opens the update dialog, and
 * one that is not says so.
 */
export async function checkForUpdatesManual(): Promise<void> {
  const res = resolve()
  if (res.channel === 'github') {
    // Work already in flight owns the answer — asking the feed again would change nothing.
    if (github.pendingInstall()) { github.offerRestart(true); return }
    if (github.isDownloading()) { await info(`Jamat ${github.pendingUpdate()} is downloading…`, 'The progress is in the status bar; the install prompt follows.'); return }
    // Otherwise ALWAYS re-query. Short-circuiting on a version a previous check happened to find meant
    // the manual check stopped touching the network for the life of the process.
    const found = await github.check('manual')
    if (found.error)
      await dialog.showMessageBox({ type: 'error', title: 'Updates', message: 'Could not check for updates.', detail: found.error })
    else if (!found.version)
      await info(`Jamat is up to date (${app.getVersion()}).`)
    // Found: `check` already opened the offer dialog — which is where the download then happens.
  } else if (res.channel === 'source') {
    const disk = source.diskVersion(res.monorepoRoot)
    if (source.diskIsNewer(disk)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Restart to Latest Build',
        message: `Restart to load build ${disk}?`,
        detail: `Running: ${getAppVersion()}\nOn disk: ${disk}\n\nRestarting closes these terminals:\n${buildSessionList()}`,
        buttons: ['Cancel', 'Restart now'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (response === 1) {
        logUpdate({ event: 'user-choice', channel: 'source', trigger: 'manual', found: disk, detail: 'restart to load the disk build' })
        await relaunchApp()
      } else {
        logUpdate({ event: 'user-choice', channel: 'source', trigger: 'manual', found: disk, detail: 'cancelled' })
      }
    } else {
      logUpdate({ event: 'check', channel: 'source', trigger: 'manual', running: getAppVersion(), found: null })
      await info(`The running build matches the sources on disk (${getAppVersion()}).`,
        'This build runs from a source checkout, so it never checks GitHub. Update the sources yourself (svn update / git pull); the app then offers to restart into the new build.')
    }
  } else if (res.channel === 'none')
    await info('Updates are not available for this build.', res.reason)
  else
    throw new Error(`Unknown update channel: ${JSON.stringify(res)}`)
}

export interface HeadlessUpdateResult {
  channel: UpdateResolution['channel']
  reason: string
  running: string
  upToDate?: boolean
  found?: string | null
  installing?: string
  downloaded?: string
  disk?: string | null
  diskNewer?: boolean
  hint?: string
  error?: string
}

/**
 * Headless update for the remote path (`POST /debug/update`, proxied by the agent's `/api/update`).
 * No dialogs — the caller gets JSON and the log gets the trail. `install` is a conscious remote act:
 * it installs even with busy tabs (they are logged).
 */
export async function runHeadlessUpdate(install: boolean): Promise<HeadlessUpdateResult> {
  const res = resolve()
  logUpdate({ event: 'remote-trigger', channel: res.channel, trigger: 'remote', running: getAppVersion(), detail: install ? 'install=1' : undefined })
  const common = { channel: res.channel, reason: res.reason, running: getAppVersion() }

  if (res.channel === 'github') {
    // Already downloaded (a consented download that landed while a terminal was busy) — install=1 is
    // the conscious "restart now anyway"; the busy tabs it closes are logged.
    const downloaded = github.pendingInstall()
    if (downloaded) {
      if (install) { github.offerRestart(true); return { ...common, installing: downloaded } }
      return { ...common, downloaded, hint: 'Repeat with install=1 to restart into it now; otherwise it installs once every terminal is idle (or on the next quit).' }
    }
    const pending = github.pendingUpdate() ?? (await github.check('remote')).version
    if (!pending) return { ...common, upToDate: true, found: null }
    // The remote caller IS the consent (install=1) — nothing downloads without it, and a remote check
    // never pops a dialog on the local user's screen.
    if (install) { github.consent(); return { ...common, installing: pending } }
    return { ...common, found: pending, hint: 'Repeat with install=1 to download it and restart into it.' }
  }

  if (res.channel === 'source') {
    const disk = source.diskVersion(res.monorepoRoot)
    const diskNewer = source.diskIsNewer(disk)
    return {
      ...common,
      disk,
      diskNewer,
      hint: diskNewer
        ? 'POST /debug/fullrestart loads the on-disk build (the launcher recompiles).'
        : 'Nothing to do — the app runs from a source checkout and the running build matches the sources. Update the sources on that machine first (the app never pulls).',
    }
  }

  if (res.channel === 'none') return { ...common }
  throw new Error(`Unknown update channel: ${JSON.stringify(res)}`)
}
