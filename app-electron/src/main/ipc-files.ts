import { ipcMain } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { existsSync, readdirSync, statSync, watch as fsWatch, type Dirent } from 'fs'
import { homedir } from 'os'
import { join, relative, resolve } from 'path'
import { spawn } from 'child_process'
import { logError } from './logger'
import { registerHandler, registerSend } from '../shared/typed-ipc'
import { publishTo } from './streams'
import { getAgent } from '../../../core/agents/index.js'
import { TerminalFilePathExtractor } from '../../../core/terminal/terminalFilePathExtractor.js'
import type { DirEntry } from '../../../core/types/ipc-contracts.js'

// Session reads route through the Claude adapter so this module stays
// agent-agnostic at the call site.
const claudeAgent = getAgent('claude')

// Expand a leading `~` (alone, `~/...`, or `~\...`) to the user's home dir.
// Windows shells don't do this, so anything Claude Code or another CLI prints
// with `~` arrives here unexpanded.
export function expandHome(p: string): string {
  if (typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1)
  return p
}

/**
 * Label shown in the Recent Files list. For files under the project dir this
 * is the plain relative path. For files edited elsewhere (e.g. a DEUSS session
 * touching ida-backend) it's relative to the nearest common ancestor so the
 * containing project stays visible, e.g. `ai-agents/ida-backend/src/foo.ts`.
 */
function displayRelative(baseDir: string, filePath: string): string {
  const baseSegs = baseDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  const fileSegs = filePath.replace(/\\/g, '/').split('/')
  let i = 0
  while (
    i < baseSegs.length &&
    i < fileSegs.length &&
    baseSegs[i].toLowerCase() === fileSegs[i].toLowerCase()
  ) i++
  if (i === baseSegs.length) {
    // Inside the project dir — plain relative path.
    return relative(baseDir, filePath).replace(/\\/g, '/')
  }
  if (i === 0) return filePath.replace(/\\/g, '/') // different drive
  return fileSegs.slice(i).join('/')
}

const fileWatchers = new Map<string, import('fs').FSWatcher>()

export function registerFileIpc(): void {
  registerHandler('file:exists', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') return false
    return existsSync(expandHome(filePath))
  })

  registerHandler('file:type', async (_event, filePath: string): Promise<'file' | 'dir' | null> => {
    if (typeof filePath !== 'string') return null
    try {
      const stat = statSync(expandHome(filePath))
      if (stat.isDirectory()) return 'dir'
      if (stat.isFile()) return 'file'
      return null
    } catch {
      return null
    }
  })

  registerHandler('file:read', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') return null
    try {
      return await readFile(expandHome(filePath), 'utf-8')
    } catch {
      return null
    }
  })

  registerHandler('file:read-binary', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') return null
    try {
      const buf = await readFile(expandHome(filePath))
      return buf.toString('base64')
    } catch {
      return null
    }
  })

  registerHandler('file:write', async (_event, filePath: string, content: string) => {
    if (typeof filePath !== 'string' || typeof content !== 'string') return { ok: false, error: 'invalid args' }
    try {
      await writeFile(expandHome(filePath), content, 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  registerHandler('file:list-recent', async (_event, dirPath: string, limit = 20) => {
    if (typeof dirPath !== 'string') return []
    dirPath = expandHome(dirPath)
    if (!existsSync(dirPath)) return []
    // A scratch/bridge session opens in the HOME dir (control-ops scratch → homedir()).
    // A recursive recent-files scan of the whole home tree is useless AND brutal — measured
    // ~56k files / ~2.8s on the main thread — and RecentFilesPanel polls it every few seconds,
    // which FROZE the app. Home is never a meaningful "project" here, so skip it outright.
    try { if (resolve(dirPath) === resolve(homedir())) return [] } catch { /* fall through */ }
    try {
      const IGNORE = new Set(['.git', '.svn', 'node_modules', '.vite', 'out', 'dist', '.next', '__pycache__'])
      const results: { path: string; name: string; mtime: number }[] = []
      // Safety cap for any OTHER pathologically-large tree: bound total entries scanned so a
      // single poll can never block the main thread for seconds.
      let visited = 0
      const MAX_ENTRIES = 12000

      const walk = (dir: string, depth: number) => {
        if (depth > 3 || visited >= MAX_ENTRIES) return
        let entries: Dirent[]
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (++visited >= MAX_ENTRIES) return
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!IGNORE.has(entry.name)) walk(full, depth + 1)
          } else {
            try {
              const stat = statSync(full)
              results.push({ path: full, name: entry.name, mtime: stat.mtimeMs })
            } catch {}
          }
        }
      }

      walk(dirPath, 0)

      // Merge in files the active Claude session edited outside this dir
      // (Edit/Write/NotebookEdit), keyed so out-of-tree work still shows up.
      const byPath = new Map<string, { path: string; name: string; mtime: number }>()
      for (const r of results) byPath.set(r.path.replace(/\\/g, '/').toLowerCase(), r)
      const sessionFile = claudeAgent.resolveActiveSessionFile(dirPath, null, homedir())
      if (sessionFile) {
        for (const fp of claudeAgent.extractEditedFiles(sessionFile)) {
          const key = fp.replace(/\\/g, '/').toLowerCase()
          if (byPath.has(key)) continue
          try {
            const stat = statSync(fp)
            if (!stat.isFile()) continue
            byPath.set(key, { path: fp, name: fp.replace(/^.*[/\\]/, ''), mtime: stat.mtimeMs })
          } catch { /* deleted/inaccessible — skip */ }
        }
      }

      const merged = [...byPath.values()]
      merged.sort((a, b) => b.mtime - a.mtime)
      return merged.slice(0, limit).map(r => ({
        path: r.path,
        name: r.name,
        mtime: r.mtime,
        relative: displayRelative(dirPath, r.path)
      }))
    } catch (err) {
      logError('file:list-recent', `${err}`)
      return []
    }
  })

  // List the IMMEDIATE children (one level) of a directory for the directory viewer panel + the
  // folder right-click menu. Each child is stat'd for type/mtime/size; unreadable entries (broken
  // symlinks, permission denied) and non-file/dir nodes are skipped. Subdirs sort first, then files;
  // within each group by name with numeric collation so `2-foo` < `10-foo` (matches numbered todo files).
  registerHandler('file:list-dir', async (_event, dirPath: string, limit = 1000): Promise<DirEntry[]> => {
    if (typeof dirPath !== 'string') return []
    const dir = expandHome(dirPath)
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      const out: DirEntry[] = []
      for (const entry of entries) {
        const full = join(dir, entry.name)
        try {
          const stat = statSync(full)
          let type: 'file' | 'dir'
          if (stat.isDirectory()) type = 'dir'
          else if (stat.isFile()) type = 'file'
          else continue
          out.push({ path: full, name: entry.name, type, mtime: stat.mtimeMs, size: type === 'file' ? stat.size : 0 })
        } catch { /* unreadable / broken symlink — skip */ }
      }
      out.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
      return out.slice(0, limit)
    } catch (err) {
      logError('file:list-dir', `${err}`)
      return []
    }
  })

  // Find real files matching a TRUNCATED path. A sub-agent (e.g. Fable skill) reports a path the
  // host TUI prints abbreviated — `…\012-brainstorm-relay-contract-extraction\01-fable.md` — so only
  // a tail survives and can't be resolved directly. We split the tail into segments and look under
  // `baseDir` for files whose trailing segments equal the LONGEST suffix that yields any match
  // (segment-aligned, so `01-fable.md` + its parent dir pin the file; a wrong/cut leading segment is
  // dropped). Walk reuses the list-recent guards (skip junk dirs, hard caps) so it can never hang.
  registerHandler('file:find-by-suffix', async (_event, baseDir: string, partial: string, limit = 8): Promise<string[]> => {
    if (typeof baseDir !== 'string' || typeof partial !== 'string') return []
    baseDir = expandHome(baseDir)
    if (!existsSync(baseDir)) return []
    // Normalize the partial into lowercase segments; drop the ellipsis/blank junk a truncation leaves.
    const segs = partial.replace(/\\/g, '/').split('/')
      .map(s => s.trim().toLowerCase())
      .filter(s => s && s !== '…' && s !== '...')
    if (segs.length === 0) return []

    try {
      const IGNORE = new Set(['.git', '.svn', 'node_modules', '.vite', 'out', 'dist', '.next', '__pycache__'])
      let visited = 0
      const MAX_ENTRIES = 20000
      const MAX_DEPTH = 12
      // Index every candidate file by its own lowercased trailing-segment list, so we can test
      // suffix matches without re-splitting. Store [absPath, segsLower].
      const files: { path: string; segs: string[] }[] = []
      const baseSegCount = baseDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).length
      // Claude truncates a name with an inline ellipsis (`2026-07-10-001-…-plan.md`), so the last
      // segment may be a wildcard, not a literal — match it (and every suffix segment) by pattern.
      const lastTester = TerminalFilePathExtractor.segTester(segs[segs.length - 1])

      const walk = (dir: string, depth: number) => {
        if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) return
        let entries: Dirent[]
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (++visited >= MAX_ENTRIES) return
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!IGNORE.has(entry.name)) walk(full, depth + 1)
          } else if (lastTester(entry.name.toLowerCase())) {
            // Only files whose basename matches the partial's last segment can ever match — cheap pre-filter.
            const parts = full.replace(/\\/g, '/').split('/').filter(Boolean).slice(baseSegCount).map(s => s.toLowerCase())
            files.push({ path: full, segs: parts })
          }
        }
      }
      walk(baseDir, 0)
      if (files.length === 0) return []

      // Longest suffix first: the most specific match wins; fall back to shorter suffixes
      // (down to the bare filename) so a cut leading segment still resolves. matchesSuffix is
      // wildcard-aware (…/.../* segments), so Claude's truncated names resolve here.
      for (let k = segs.length; k >= 1; k--) {
        const suffix = segs.slice(segs.length - k)
        const matches = files.filter(f => TerminalFilePathExtractor.matchesSuffix(f.segs, suffix))
        if (matches.length > 0) return matches.slice(0, limit).map(m => m.path)
      }
      return []
    } catch (err) {
      logError('file:find-by-suffix', `${err}`)
      return []
    }
  })

  registerHandler('file:open-in-vscode', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, error: 'invalid filePath' }
    }
    const resolved = expandHome(filePath)
    try {
      // Spawn the .cmd shim directly on Windows; using `shell: true` would
      // route through cmd.exe and let metacharacters (`&`, `|`, `^`) in the
      // file path execute as commands. Path with spaces / special chars is
      // passed atomically via the args array — no shell parsing involved.
      const bin = process.platform === 'win32' ? 'code.cmd' : 'code'
      const child = spawn(bin, [resolved], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return { ok: true }
    } catch (err) {
      const msg = String(err)
      logError('file:open-in-vscode', msg)
      return { ok: false, error: msg }
    }
  })

  registerSend('file:watch', (event, filePath: string) => {
    if (typeof filePath !== 'string') return
    const resolved = expandHome(filePath)
    if (fileWatchers.has(resolved)) return
    try {
      const watcher = fsWatch(resolved, { persistent: false }, () => {
        if (!event.sender.isDestroyed()) publishTo(event.sender, 'file:changed', filePath)
      })
      watcher.on('error', () => {})
      fileWatchers.set(resolved, watcher)
    } catch {}
  })

  registerSend('file:unwatch', (_event, filePath: string) => {
    if (typeof filePath !== 'string') return
    const resolved = expandHome(filePath)
    const watcher = fileWatchers.get(resolved)
    if (watcher) {
      watcher.close()
      fileWatchers.delete(resolved)
    }
  })

}
