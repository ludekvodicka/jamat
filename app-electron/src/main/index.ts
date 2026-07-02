import './bootstrap-userdata' // MUST be first — overrides userData before any module reads it
import { app } from 'electron'
import { logError } from './logger'

process.on('uncaughtException', (error) => {
  logError('main', `Uncaught: ${error.message}\n${error.stack ?? ''}`)
})

import { destroyAll } from './pty-manager'
import { getIsRestarting } from './app-state'
import { registerLayoutIpc } from './ipc-layout'
import { registerFileIpc } from './ipc-files'
import { registerAbilitiesIpc } from './ipc-abilities'
import { registerSessionIpc } from './ipc-sessions'
import { registerFileDiffIpc } from './ipc-file-diff'
import { registerCommitIpc } from './ipc-commit'
import { registerAgentIpc } from './ipc-agents'
import { registerRemoteConfigIpc } from './ipc-remote'
import { registerRemoteClientIpc } from './remote-client'
import { registerTabTreeCache } from './tab-tree-cache'
import { startOpServer, reconcileOpServer, stopOpServer } from './op-server'
import { sweepRetention } from './remote-activity'
import { startUsagePolling, stopUsagePolling } from './usage-manager'
import { startUpdateChecker } from './update-checker'
import { startAutoUpdater } from './auto-updater'
import {
  loadScreenConfig,
  getAppConfig,
  createAppWindow,
  restoreSavedWindows,
  rebuildMenu,
  getWindows,
  registerWindowIpc,
  registerPtyIpc,
  processPendingTab,
  setWindowStateManager,
  getMonorepoRoot
} from './ipc-windows'
import { isFirstInstance, setAsFirstInstance, clearInstanceMarker, loadWindowState } from './window-state-manager'
import { mountOpAdapter } from '../shared/typed-ipc'
import { registerAllOps } from './op-registry'
import { ensureSkillLinks } from './ensure-skill-links'
import { repairClaudeJsonIfCorrupt } from './claude-json-repair'

app.whenReady().then(async () => {
  // Start the op-server's LOCAL listener first (the always-on localhost dev surface,
  // /debug + /jamat + /op) so its console log-buffer captures [config] messages from
  // loadScreenConfig (previously these printed before the buffer existed and were
  // invisible to /debug/logs). The conditional LAN listener starts later (after windows).
  startOpServer()
  await loadScreenConfig()
  // Ensure this repo's project-local skills are junctioned into ~/.claude/skills (creates/
  // repoints on every start, so each machine gets them without a manual mklink). Non-fatal.
  ensureSkillLinks(getMonorepoRoot())
  registerLayoutIpc()
  registerFileIpc()
  registerAbilitiesIpc()
  registerSessionIpc()
  registerFileDiffIpc()
  registerCommitIpc()
  registerAgentIpc()
  registerRemoteConfigIpc()
  registerRemoteClientIpc()
  registerTabTreeCache()
  registerWindowIpc()
  registerPtyIpc()
  // op layer (plan 002 P1): every register*Ipc above auto-registered its ops; now set the
  // packaged flag (dispatch's devOnly gate) and mount the single renderer→op IPC entry. A
  // registration failure (e.g. a duplicate op name) must NOT leave a half-booted app (local
  // listener up, windows never created) — fail fast + visibly.
  try {
    registerAllOps()
  } catch (err) {
    logError('op-registry', `op registration failed — aborting: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    stopOpServer() // release the local listener bound above (no windows exist yet → window-all-closed won't fire)
    app.quit()
    return
  }
  mountOpAdapter()
  const config = getAppConfig()
  if (config) startUsagePolling(config)
  // Background update watchers — both wait for all tabs idle before the inevitable restart, and
  // each self-gates on `selfUpdate.provider`: the VCS self-pull checker (provider 'vcs'/default,
  // the owner's source checkout) and the GitHub-Releases auto-updater (provider 'github', packaged
  // public builds). They self-delay the first network poll, so starting them before windows exist
  // is fine. No-ops unless `selfUpdate` is configured for the matching channel.
  startUpdateChecker()
  startAutoUpdater()
  rebuildMenu()
  // Op-server LAN listener (the Remote App Control surface) — binds only when enabled &&
  // a valid key is set (closed-by-default). Reconciled after windows exist so the tab-tree
  // cache and PTY ring buffer are populated before a peer can connect.
  reconcileOpServer()

  // Prune the append-only remote-activity audit + delegated-task drop dir so neither
  // grows unbounded over months of use. Best-effort background sweep (older than 30d).
  sweepRetention()

  // Heal a ~/.claude.json left corrupt by a prior hard-kill (interrupted in-place write → stale
  // trailing bytes) BEFORE any tab launches `claude` — so the restored sessions read a clean file
  // instead of each detecting corruption, snapshotting, and recovering. Safe truncate-only; no-op
  // when the file is fine or the corruption shape is unknown.
  repairClaudeJsonIfCorrupt()

  // Handle first instance: restore windows, or create new one
  if (isFirstInstance()) {
    setAsFirstInstance()
    logError('main', 'First instance detected, restoring windows')
    // Staggered restore: first window immediately, the rest one per interval, so several
    // saved windows don't all spawn their Claude tabs in the same instant (concurrent
    // ~/.claude.json writes corrupt it). The spawn gate in screen-executor serializes the
    // actual agent launches across all windows/tabs.
    restoreSavedWindows(loadWindowState())
  } else {
    logError('main', 'Subsequent instance detected, creating new window')
    createAppWindow({ windowId: '0', isNew: true })
  }

  setTimeout(processPendingTab, 2000)
})

app.on('window-all-closed', () => {
  if (getIsRestarting()) return
  stopUsagePolling()
  stopOpServer()
  destroyAll()
  clearInstanceMarker()
  app.quit()
})
