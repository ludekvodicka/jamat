/**
 * Background update checker (Electron only).
 *
 * Watches the app's OWN repo for a newer build and, once it's safe, offers a
 * one-click update. The flow the user asked for:
 *
 *   1. Poll the repo HEAD's `package.json` `version` (WITHOUT pulling) on an
 *      interval. A teammate/other machine committing a `npm run bump` makes HEAD's
 *      version newer than this running build's `getAppVersion()`.
 *   2. When a newer version exists, WAIT until every tab in every window is idle —
 *      no Claude turn `running` / `tool-use`, and none `blocked` on user input — so
 *      the inevitable restart never interrupts live agent work.
 *   3. Prompt: "new version available" → Update now / Postpone 1h / 2h / 4h / 12h.
 *      Update now pulls + relaunches (reusing the manual action's core, no second
 *      confirm). Postpone silences the prompt for the window; meanwhile it keeps
 *      polling (so it targets the newest version) and re-asks once the window passes
 *      and things are idle again.
 *
 * Reads the running version from `getAppVersion()` (memoised at process start, so it
 * reflects the CODE actually executing — see ipc-windows). Idle is read from the same
 * renderer-pushed tab cache the manual confirm dialog uses (`getWindowsTabs`), and we
 * re-evaluate reactively via `onTabsChanged` instead of busy-polling.
 */
import { dialog } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getAppConfig, getAppVersion } from './ipc-windows'
import { resolveRepoPath, pullAndRelaunch } from './self-update'
import { onTabsChanged, allTabsIdle } from './tab-tree-cache'
import { logError, logInfo } from './logger'
import type { SelfUpdateConfig } from '../../../core/types.js'

const INITIAL_DELAY_MS = 45_000          // let the app settle before the first network poll
const DEFAULT_INTERVAL_MIN = 120
const REPO_READ_TIMEOUT_MS = 30_000
const POSTPONE_HOURS = [1, 2, 4, 12]     // maps to the four "Postpone" buttons

let started = false
let pendingVersion: string | null = null // newest repo version we've seen that beats the running build
let postponeUntilMs = 0
let prompting = false
let checking = false
let intervalTimer: ReturnType<typeof setInterval> | null = null
let postponeTimer: ReturnType<typeof setTimeout> | null = null

/** Numeric `YYYY.MM.DD.HH.mm`(.…) compare. >0 ⇒ a is newer than b. Tolerates extra/!numeric parts. */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Run a VCS command in the repo, resolving its stdout (trimmed) or null on failure. */
function runRead(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: true })
    let out = ''
    let err = ''
    let settled = false
    const finish = (v: string | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish(null) }, REPO_READ_TIMEOUT_MS)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { logError('update-checker', `${cmd} spawn failed: ${e.message}`); finish(null) })
    child.on('close', (code) => {
      if (code !== 0) { logError('update-checker', `${cmd} ${args.join(' ')} exit ${code}: ${err.trim()}`); finish(null); return }
      finish(out)
    })
  })
}

/** The version in the on-disk working-copy package.json — what a restart would ACTUALLY load —
 *  read FRESH. On the machine where `npm run bump` just ran, this is AHEAD of HEAD until committed,
 *  so the prompt must target it (not HEAD) to avoid offering a version older than the disk. */
function readDiskVersion(repoPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch { return null }
}

/** Read the version string from the repo HEAD's package.json, without touching the working copy. */
async function readRepoVersion(cfg: SelfUpdateConfig, repoPath: string): Promise<string | null> {
  let raw: string | null
  if (cfg.vcs === 'svn') {
    // `-r HEAD` makes svn fetch the server copy; relative path + cwd avoids space/quoting issues.
    raw = await runRead('svn', ['cat', '-r', 'HEAD', 'package.json'], repoPath)
  } else {
    // git: refresh the upstream ref, then read package.json from it (@{u} = tracking branch).
    await runRead('git', ['fetch', '--quiet'], repoPath)
    raw = await runRead('git', ['show', '@{u}:package.json'], repoPath)
  }
  if (!raw) return null
  try {
    const v = JSON.parse(raw)?.version
    return typeof v === 'string' ? v : null
  } catch (e) {
    logError('update-checker', `could not parse repo package.json: ${(e as Error).message}`)
    return null
  }
}

async function showPrompt(): Promise<void> {
  if (prompting || !pendingVersion) return
  prompting = true
  const target = pendingVersion
  try {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Update available',
      message: `Jamat — a newer version is available (${target}).`,
      detail: `Currently running: ${getAppVersion()}\nNew version:    ${target}\n\nAll terminals are idle now — the update will pull changes and restart the app.`,
      buttons: ['Update now', 'Snooze 1h', 'Snooze 2h', 'Snooze 4h', 'Snooze 12h'],
      defaultId: 0,
      cancelId: 1, // Esc / close ⇒ postpone 1h, never an accidental restart
      noLink: true,
    })
    if (response === 0) {
      logInfo('update-checker', `user accepted update to ${target}`)
      // pullAndRelaunch relaunches the whole process on success (this code stops running).
      // If it returns (no changes / failure dialog shown), drop the pending mark and let the
      // next poll re-detect — avoids re-prompting in a tight loop for the same version.
      await pullAndRelaunch()
      pendingVersion = null
    } else {
      const hours = POSTPONE_HOURS[response - 1] ?? 1
      postponeUntilMs = Date.now() + hours * 60 * 60 * 1000
      logInfo('update-checker', `update to ${target} postponed ${hours}h`)
      schedulePostponeWake(hours * 60 * 60 * 1000)
    }
  } finally {
    prompting = false
  }
}

/** Try to surface the prompt: only when an update is pending, the postpone window has passed,
 *  nothing else is prompting, and every tab is idle. Called on a timer, on tab-status changes,
 *  and right after a successful repo poll. */
function maybePrompt(): void {
  if (!pendingVersion || prompting) return
  if (Date.now() < postponeUntilMs) return
  if (!allTabsIdle()) return
  void showPrompt()
}

/** Re-attempt the prompt right when a postpone window elapses (if idle by then). */
function schedulePostponeWake(ms: number): void {
  if (postponeTimer) clearTimeout(postponeTimer)
  postponeTimer = setTimeout(() => { postponeTimer = null; maybePrompt() }, ms + 1000)
}

async function checkRepo(): Promise<void> {
  if (checking) return
  const cfg = getAppConfig()
  if (!cfg?.selfUpdate) return
  checking = true
  try {
    const repoPath = resolveRepoPath(cfg.selfUpdate)
    // What a pull+restart would ACTUALLY load = the NEWEST of HEAD (svn cat -r HEAD = what a pull
    // brings) and the on-disk working copy (AHEAD of HEAD on the machine that just bumped, since
    // `svn update` keeps the local-ahead version). Comparing HEAD alone made the prompt offer a
    // version OLDER than the disk on the bumping machine ("New version 19.00" while disk was 08.26).
    const head = await readRepoVersion(cfg.selfUpdate, repoPath) // null on network/auth/parse failure
    const disk = readDiskVersion(repoPath)
    const target = [head, disk].reduce<string | null>(
      (best, v) => (v && (!best || compareVersion(v, best) > 0)) ? v : best, null)
    if (!target) return // couldn't read either source; try again next interval
    const running = getAppVersion()
    if (compareVersion(target, running) <= 0) {
      // Up to date (running build already ≥ what a restart would load). Clear any stale pending mark.
      if (pendingVersion && compareVersion(target, pendingVersion) >= 0) pendingVersion = null
      return
    }
    // Newer than running — track the NEWEST we've seen (so postpone targets the latest).
    if (!pendingVersion || compareVersion(target, pendingVersion) > 0) {
      logInfo('update-checker', `newer build available: ${target} (head=${head ?? '?'} disk=${disk ?? '?'} running=${running})`)
      pendingVersion = target
    }
    maybePrompt()
  } finally {
    checking = false
  }
}

/** Start the background checker. No-op unless `selfUpdate` is configured and `autoCheck` isn't false. */
export function startUpdateChecker(): void {
  if (started) return
  const cfg = getAppConfig()
  const su = cfg?.selfUpdate
  if (!su) return
  if (su.provider === 'github') return // GitHub Releases channel — handled by auto-updater.ts (packaged public builds)
  if (su.autoCheck === false) { logInfo('update-checker', 'disabled via selfUpdate.autoCheck=false'); return }
  started = true

  const intervalMs = Math.max(1, su.checkIntervalMinutes ?? DEFAULT_INTERVAL_MIN) * 60 * 1000
  logInfo('update-checker', `enabled (vcs=${su.vcs}, every ${Math.round(intervalMs / 60000)} min)`)

  setTimeout(() => { void checkRepo() }, INITIAL_DELAY_MS)
  intervalTimer = setInterval(() => { void checkRepo() }, intervalMs)
  // React the moment everything goes idle (a tab finished its turn) instead of waiting for a poll.
  onTabsChanged(() => maybePrompt())
}

/** Stop timers (for teardown/tests). */
export function stopUpdateChecker(): void {
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
  if (postponeTimer) { clearTimeout(postponeTimer); postponeTimer = null }
  started = false
}
