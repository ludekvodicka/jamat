/**
 * Debug ops — the localhost dev-tooling surface, as registry ops (plan 002 P2).
 *
 * These were the `/debug/*` routes inside `debug-api.ts`'s request handler. They now
 * live in the op registry with `reach: ['ui','ai','remote']` — reachable from the
 * renderer, localhost (`via:'ai'`) AND a remote peer (`via:'remote'`), so a peer can be
 * debugged/controlled (logs, terminals, restart, fullrestart…) from the Remote
 * connections list in the UI. This deliberately departs from V1 (debug-api bound
 * 127.0.0.1 only): under the unified one-key model "key == full power" (a remote caller
 * who passed the gate can already inject arbitrary commands via `control:write-keys`),
 * so a separate localhost-only debug zone bought no real safety. Remote access still
 * runs the full LAN gate (enabled + Host-allowlist + no-Origin + bearer key + rate
 * limit), reached only through the generic `/op` endpoint. The op-server's `/debug/*`
 * adapter passes `{ ...query, ...body }` as the single arg and sends `result.data`
 * verbatim.
 *
 * `devOnly: true` (rejected when `app.isPackaged`) marks the ops that need the source
 * tree — `build-reload`, `build-restart`, `generate-stats`. `reload`/`restart`/
 * `fullrestart` are NOT dev-only (the remote update+restart flow drives `fullrestart`
 * on a packaged production app — see the bridge remote-restart note).
 *
 * The generic reflection route (`/debug/ipc/<channel>`) is GONE — `/op` now dispatches
 * any op by name under the same reach gate, so no second closed-by-default allowlist is
 * needed. The two curl aliases (`/debug/file-diff-options`, `/debug/sessions/rename`)
 * are routed by the op-server straight to their P1 IPC ops (`file-diff:list-options`,
 * `sessions:rename`) — no dedicated op here.
 */

import { app, BrowserWindow } from 'electron'
import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { homedir } from 'node:os'
import { registerOp } from '../../../../core/op/registry.js'
import type { Result } from '../../../../core/op/types.js'
import { publishTo } from '../streams'
import { prepareForRestart } from '../op-server'
import { destroyAll, listPtys } from '../pty-manager'
import { getScreenState } from '../screen-executor'
import { getLogBuffer } from '../logger'
import { getAppConfig, restartAllWindows, getMenuDir, getMonorepoRoot } from '../ipc-windows'
import { relaunchApp } from '../self-update'
import { getUsageCache, forceRefreshUsage } from '../usage-manager'
import { getAgent } from '../../../../core/agents/index.js'
import { getRemoteActivityLog } from '../app-state'

const claudeAgent = getAgent('claude')
// reach includes 'remote' so the UI's Remote list can debug/control a peer (see header).
const REACH = ['ui', 'ai', 'remote'] as const

// Serialize concurrent self-updates: two VCS processes on one working copy → lock/corruption.
let updateInFlight = false

export function registerDebugOps(): void {
  // ── core / state reads ─────────────────────────────────────────────────────
  registerOp({
    name: 'debug:health',
    meta: { summary: 'Liveness probe', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({ ok: true, data: { ok: true } }),
  })

  registerOp({
    name: 'debug:info',
    meta: { summary: 'Process info (pid/uptime/mem/windows/terminals)', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({
      ok: true,
      data: {
        app: 'jamat-electron',
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        nodeVersion: process.version,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        windows: BrowserWindow.getAllWindows().length,
        terminals: listPtys().length,
        packaged: app.isPackaged,
      },
    }),
  })

  registerOp({
    name: 'debug:logs',
    meta: { summary: 'Console log buffer (?since, ?source)', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (args): Result => {
      const q = (args[0] ?? {}) as any
      let logs = getLogBuffer()
      if (q.since) { const since = parseInt(String(q.since)); if (!isNaN(since)) logs = logs.filter((l) => l.ts > since) }
      if (q.source) logs = logs.filter((l) => l.source.includes(String(q.source)))
      return { ok: true, data: { count: logs.length, logs } }
    },
  })

  registerOp({
    name: 'debug:remote-activity-log',
    meta: { summary: 'Remote Activity Log dump (?since)', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (args, ctx): Result => {
      const q = (args[0] ?? {}) as any
      let entries = getRemoteActivityLog()
      if (q.since) { const since = parseInt(String(q.since)); if (!isNaN(since)) entries = entries.filter((e) => e.ts > since) }
      // `payload` holds the literal injected keystrokes / task text — kept LOCAL for forensics,
      // never echoed over the network. A remote caller gets a redacted projection (payload stripped).
      if (ctx.via === 'remote') entries = entries.map(({ payload, ...rest }) => rest)
      return { ok: true, data: { count: entries.length, entries } }
    },
  })

  registerOp({
    name: 'debug:config',
    meta: { summary: 'Safe config summary (name + category labels)', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => {
      const cfg = getAppConfig()
      const safe = cfg ? { name: cfg.name, categories: cfg.categories?.map((c) => c.label) ?? [] } : null
      return { ok: true, data: { config: safe } }
    },
  })

  registerOp({
    name: 'debug:windows',
    meta: { summary: 'Electron window list', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({
      ok: true,
      data: {
        windows: BrowserWindow.getAllWindows().map((win) => {
          const bounds = win.getBounds()
          return { id: win.id, title: win.getTitle(), focused: win.isFocused(), minimized: win.isMinimized(), width: bounds.width, height: bounds.height }
        }),
      },
    }),
  })

  registerOp({
    name: 'debug:terminals',
    meta: { summary: 'Live PTY list', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({ ok: true, data: { terminals: listPtys() } }),
  })

  registerOp({
    name: 'debug:screen-state',
    meta: { summary: 'Tab-title pipeline inspection', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({ ok: true, data: { terminals: getScreenState() } }),
  })

  registerOp({
    name: 'debug:usage',
    meta: { summary: 'Usage cache', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({ ok: true, data: { usage: getUsageCache() } }),
  })

  registerOp({
    name: 'debug:usage-refresh',
    meta: { summary: 'Force a usage refresh', reach: [...REACH], rw: 'rw', audit: 'never' },
    handler: (): Result => {
      try { return { ok: true, data: { usage: forceRefreshUsage() } } }
      catch (e: any) { return { ok: false, error: String(e?.message ?? e), code: 'threw' } }
    },
  })

  // ── actions (process lifecycle) ────────────────────────────────────────────
  // reload/restart/fullrestart are NOT dev-only: the remote update+restart flow drives
  // fullrestart on a packaged production app.
  registerOp({
    name: 'debug:reload',
    meta: { summary: 'Reload all renderer windows (drops PTYs)', reach: [...REACH], rw: 'rw', audit: 'discrete' },
    handler: (): Result => {
      prepareForRestart() // close LAN WS viewers + reset indicator before the PTYs they watch die
      destroyAll()
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.reloadIgnoringCache()
      return { ok: true, data: { ok: true, action: 'reload' } }
    },
  })

  registerOp({
    name: 'debug:restart',
    meta: { summary: 'Recreate all windows in-process', reach: [...REACH], rw: 'rw', audit: 'discrete' },
    handler: (): Result => {
      prepareForRestart() // close LAN WS viewers + reset indicator before the windows/PTYs are recreated
      setTimeout(() => restartAllWindows(), 100)
      return { ok: true, data: { ok: true, action: 'restart' } }
    },
  })

  registerOp({
    name: 'debug:fullrestart',
    meta: { summary: 'Full process relaunch (main code reloads too)', reach: [...REACH], rw: 'rw', audit: 'discrete' },
    handler: (): Result => {
      setTimeout(() => { void relaunchApp() }, 100)
      return { ok: true, data: { ok: true, action: 'fullrestart' } }
    },
  })

  registerOp({
    name: 'debug:build-reload',
    meta: { summary: 'electron-vite build → reload windows', reach: [...REACH], rw: 'rw', devOnly: true, audit: 'discrete' },
    handler: (): Result => {
      try {
        execSync('npx electron-vite build', { cwd: app.getAppPath(), timeout: 30000 })
        prepareForRestart()
        destroyAll()
        for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.reloadIgnoringCache()
        return { ok: true, data: { ok: true, action: 'build-reload' } }
      } catch (e: any) { return { ok: false, error: e.stderr?.toString() ?? e.message, code: 'threw' } }
    },
  })

  registerOp({
    name: 'debug:build-restart',
    meta: { summary: 'electron-vite build → recreate windows', reach: [...REACH], rw: 'rw', devOnly: true, audit: 'discrete' },
    handler: (): Result => {
      try {
        execSync('npx electron-vite build', { cwd: app.getAppPath(), timeout: 30000 })
        prepareForRestart()
        setTimeout(() => restartAllWindows(), 100)
        return { ok: true, data: { ok: true, action: 'build-restart' } }
      } catch (e: any) { return { ok: false, error: e.stderr?.toString() ?? e.message, code: 'threw' } }
    },
  })

  // The "update" half of remote update+restart, in the APP's own op layer. This used to live ONLY
  // in app-agent's /api/update — but the agent is a SEPARATE always-on process that may be down
  // (it serves the app-CLOSED case: pull + launch). A RUNNING app must be able to self-update
  // without it. NOT devOnly: a packaged app pulls source, then a fullrestart makes the launcher
  // recompile on the version bump; a dev electron-vite watch reloads on the pulled files. The
  // caller chains debug:fullrestart for the restart half.
  registerOp({
    name: 'debug:update',
    meta: { summary: 'Pull latest source (git pull / svn update) into the monorepo', reach: [...REACH], rw: 'rw', audit: 'discrete' },
    handler: async (): Promise<Result> => {
      if (updateInFlight) return { ok: false, error: 'update already in progress', code: 'conflict' }
      updateInFlight = true
      const root = getMonorepoRoot()
      // This project is SVN-primary (the git→SVN migration; the old Gitea git host is
      // decommissioned and must NOT be pulled from). Prefer `svn update` for any SVN checkout;
      // fall back to `git pull` only for a git-only checkout (no .svn) with its own real remote.
      const useSvn = existsSync(pathJoin(root, '.svn')) || existsSync(pathJoin(root, '..', '.svn'))
      const cmd = useSvn ? 'svn' : 'git'
      const args = useSvn ? ['update', root] : ['-C', root, 'pull']
      return await new Promise<Result>((resolveResult) => {
        let out = ''
        let settled = false
        const finish = (r: Result) => { if (settled) return; settled = true; updateInFlight = false; clearTimeout(timer); resolveResult(r) }
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(cmd, args, { shell: true })
        } catch (e: any) {
          finish({ ok: false, error: `update failed to start: ${e?.message ?? e}`, code: 'threw' })
          return
        }
        const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish({ ok: false, error: 'update timeout after 120s', code: 'threw' }) }, 120_000)
        child.stdout?.on('data', (d) => { out += d.toString() })
        child.stderr?.on('data', (d) => { out += d.toString() })
        child.on('error', (e) => finish({ ok: false, error: e.message, code: 'threw' }))
        child.on('close', (code) => {
          if (code === 0) finish({ ok: true, data: { ok: true, action: 'update', vcs: cmd, code, output: out.slice(-4000) } })
          else finish({ ok: false, error: out.slice(-4000) || `${cmd} exited with code ${code}`, code: 'threw' })
        })
      })
    },
  })

  registerOp({
    name: 'debug:open-tab',
    meta: { summary: 'Open a tab via the menu:new-tab-type event (?type)', reach: [...REACH], rw: 'rw', audit: 'discrete' },
    handler: (args): Result => {
      const q = (args[0] ?? {}) as any
      const tabType = q.type || 'claude'
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) return { ok: false, error: 'No window', code: 'no_window' }
      publishTo(win.webContents, 'menu:new-tab-type', tabType)
      return { ok: true, data: { ok: true, tabType } }
    },
  })

  // ── sessions / file-changes (reads via the Claude adapter) ──────────────────
  registerOp({
    name: 'debug:sessions',
    meta: { summary: 'List Claude sessions for a project (?project)', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (args): Result => {
      const q = (args[0] ?? {}) as any
      const projectDir = q.project ?? ''
      if (!projectDir) return { ok: false, error: 'Pass ?project=<projectDir>', code: 'bad_args' }
      const projDir = claudeAgent.findProjectDir(projectDir, homedir())
      if (!projDir) return { ok: false, error: `Project dir not found for: ${projectDir}`, code: 'not_found' }
      const sessions = claudeAgent.listSessionsForProject(projDir, homedir())
      return { ok: true, data: { projectDir, resolvedTo: projDir, sessionCount: sessions.length, sessions } }
    },
  })

  // POST: fire the debug:sessions-open renderer event (action). GET equivalent below = a check.
  registerOp({
    name: 'debug:sessions-open',
    meta: { summary: 'Send debug:sessions-open to the renderer (?project,?session)', reach: [...REACH], rw: 'rw', audit: 'discrete' },
    handler: (args): Result => {
      const q = (args[0] ?? {}) as any
      const projectDir = q.project ?? ''
      const sessionId = q.session ?? ''
      if (!projectDir || !sessionId) return { ok: false, error: 'Pass ?project=<projectDir>&session=<sessionId>', code: 'bad_args' }
      const projDir = claudeAgent.findProjectDir(projectDir, homedir())
      if (!projDir) return { ok: false, error: `Project dir not found for: ${projectDir}`, code: 'not_found' }
      const sessions = claudeAgent.listSessionsForProject(projDir, homedir())
      const session = sessions.find((s) => s.sessionId === sessionId)
      if (!session) return { ok: false, error: `Session not found: ${sessionId}`, code: 'not_found' }
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (!win) return { ok: false, error: 'No window available', code: 'no_window' }
      console.log(`[debug/sessions/open] Sending debug:sessions-open event to renderer (no listener wired yet — see todo 045)`)
      win.webContents.send('debug:sessions-open', projectDir, sessionId)
      return {
        ok: true,
        data: {
          ok: true, message: 'debug:sessions-open event sent to renderer (no listener wired in renderer yet)',
          projectDir, sessionId, projDir,
          session: { sessionId: session.sessionId, slug: session.slug, active: session.active, lastActivity: new Date(session.lastActivity).toISOString() },
          window: { id: win.id, title: win.getTitle() },
        },
      }
    },
  })

  registerOp({
    name: 'debug:sessions-open-check',
    meta: { summary: 'Diagnostic check for sessions-open (?project,?session)', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (args): Result => {
      const q = (args[0] ?? {}) as any
      const projectDir = q.project ?? ''
      const sessionId = q.session ?? ''
      if (!projectDir || !sessionId) return { ok: false, error: 'Pass ?project=<projectDir>&session=<sessionId>', code: 'bad_args' }
      const projDir = claudeAgent.findProjectDir(projectDir, homedir())
      const projDirStatus = projDir ? 'found' : 'NOT_FOUND'
      const sessions = projDir ? claudeAgent.listSessionsForProject(projDir, homedir()) : []
      const sessionStatus = sessions.find((s) => s.sessionId === sessionId) ? 'found' : 'NOT_FOUND'
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      return {
        ok: true,
        data: {
          status: 'check', projectDir, sessionId, projDirStatus, projectDirPath: projDir || 'n/a',
          sessionsCount: sessions.length, sessionStatus, windowExists: !!win, windowId: win?.id || null,
          windowTitle: win?.getTitle() || null, appConfig: getAppConfig() ? 'loaded' : 'NOT_LOADED', menuDir: getMenuDir(),
        },
      }
    },
  })

  registerOp({
    name: 'debug:file-changes',
    meta: { summary: 'File Changes panel inspection (?project,?session,?deep)', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (args): Result => {
      const q = (args[0] ?? {}) as any
      const projectDir = q.project ?? ''
      if (!projectDir) return { ok: false, error: 'Pass ?project=<projectDir> [&session=<sessionId>]', code: 'bad_args' }
      const projDir = claudeAgent.findProjectDir(projectDir, homedir())
      if (!projDir) return { ok: false, error: `Project dir not found for: ${projectDir}`, code: 'not_found' }
      const sessions = claudeAgent.listSessionsForProject(projDir, homedir())
      const rows = sessions.map((s) => {
        const jsonlPath = pathJoin(projDir, `${s.sessionId}.jsonl`)
        const hasEdits = claudeAgent.hasFileEdits(jsonlPath)
        let turnCount: number | null = null
        let turnsWithFiles: number | null = null
        let totalEdits: number | null = null
        if (hasEdits || q.deep === '1') {
          const turns = claudeAgent.extractTurns(jsonlPath)
          turnCount = turns.length
          turnsWithFiles = turns.filter((t) => t.files.length > 0).length
          totalEdits = turns.reduce((n, t) => n + t.files.reduce((m, f) => m + f.editCount, 0), 0)
        }
        return {
          sessionId: s.sessionId, slug: s.slug, active: s.active,
          lastActivity: new Date(s.lastActivity).toISOString(), hasEdits, turnCount, turnsWithFiles, totalEdits,
        }
      })
      const visible = rows.filter((r) => r.hasEdits)
      const hidden = rows.filter((r) => !r.hasEdits)

      let sessionDetail: unknown = null
      if (q.session) {
        if (!sessions.some((s) => s.sessionId === q.session)) {
          return { ok: false, error: `Session not found in project: ${q.session}`, code: 'not_found' }
        }
        const jsonlPath = pathJoin(projDir, `${q.session}.jsonl`)
        const turns = claudeAgent.extractTurns(jsonlPath)
        sessionDetail = {
          sessionId: q.session, turnCount: turns.length,
          turns: turns.map((t) => ({
            turnIndex: t.turnIndex, timestampISO: t.timestampISO, userPromptTextShort: t.userPromptTextShort,
            filesCount: t.files.length, totalEdits: t.files.reduce((m, f) => m + f.editCount, 0),
            files: t.files.map((f) => ({
              filePath: f.filePath, editCount: f.editCount, isNewFile: f.isNewFile, isOverwritten: f.isOverwritten,
              disjoint: f.disjoint, beforeLen: f.beforeText.length, afterLen: f.afterText.length,
            })),
            hiddenByHideEmpty: t.files.length === 0,
          })),
        }
      }
      return {
        ok: true,
        data: {
          projectDir, resolvedTo: projDir, totalSessions: rows.length,
          visibleWithHideEmpty: visible.length, hiddenByHideEmpty: hidden.length, sessions: rows, sessionDetail,
        },
      }
    },
  })

  registerOp({
    name: 'debug:generate-stats',
    meta: { summary: 'Regenerate the usage stats dashboard (async)', reach: [...REACH], rw: 'rw', devOnly: true, audit: 'discrete' },
    handler: (): Result => {
      const start = Date.now()
      const { spawn } = require('child_process') as typeof import('child_process')
      const { resolve: pathResolve } = require('path') as typeof import('path')
      const root = pathResolve(__dirname, '..', '..', '..')
      const statsScript = pathResolve(root, 'app-stats', 'generate-stats.ts')
      const htmlScript = pathResolve(root, 'app-stats', 'generate-html.ts')
      const tsxBin = pathResolve(root, 'node_modules', '.bin', 'tsx.cmd')
      const child = spawn(tsxBin, [statsScript], { cwd: root, stdio: 'pipe', shell: true })
      child.on('close', (code) => {
        console.log(`[stats] generate-stats code=${code} ${Date.now() - start}ms`)
        if (code !== 0) return
        const child2 = spawn(tsxBin, [htmlScript], { cwd: root, stdio: 'pipe', shell: true })
        child2.on('close', (code2) => { console.log(`[stats] generate-html code=${code2} total=${Date.now() - start}ms`) })
      })
      return { ok: true, data: { ok: true, message: 'Starting async stats generation' } }
    },
  })
}
