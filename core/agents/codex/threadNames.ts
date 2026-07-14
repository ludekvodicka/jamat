import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { SESSION_ID_RE } from '../../types/contracts.js'
import type { SessionTitleWatchTarget } from '../types.js'

interface SessionIndexRecord {
  id?: unknown
  thread_name?: unknown
}

interface ThreadNamesCache {
  mtimeMs: number
  size: number
  names: Map<string, string>
}

export class CodexThreadNames {
  private static readonly indexFile = 'session_index.jsonl'
  private static readonly rolloutIdPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  private static readonly cache = new Map<string, ThreadNamesCache>()

  static all(homeDir: string): ReadonlyMap<string, string> {
    return CodexThreadNames.load(CodexThreadNames.indexPath(homeDir))
  }

  static getForSessionFile(sessionFile: string): string | null {
    const codexHome = CodexThreadNames.codexHomeForSessionFile(sessionFile)
    const sessionId = CodexThreadNames.sessionIdForFile(sessionFile)
    if (!codexHome || !sessionId) return null
    return CodexThreadNames.load(join(codexHome, CodexThreadNames.indexFile)).get(sessionId) ?? null
  }

  static appendForSessionFile(sessionFile: string, sessionId: string, title: string): boolean {
    if (!SESSION_ID_RE.test(sessionId) || !existsSync(sessionFile)) return false
    if (CodexThreadNames.sessionIdForFile(sessionFile) !== sessionId) return false
    const codexHome = CodexThreadNames.codexHomeForSessionFile(sessionFile)
    const threadName = title.trim()
    if (!codexHome || !threadName) return false
    const path = join(codexHome, CodexThreadNames.indexFile)
    const record = JSON.stringify({ id: sessionId, thread_name: threadName, updated_at: new Date().toISOString() })
    try {
      let prefix = ''
      if (existsSync(path)) {
        const size = statSync(path).size
        if (size > 0) {
          const fd = openSync(path, 'r')
          try {
            const last = Buffer.alloc(1)
            readSync(fd, last, 0, 1, size - 1)
            if (last[0] !== 0x0a) prefix = '\n'
          } finally {
            closeSync(fd)
          }
        }
      }
      appendFileSync(path, `${prefix}${record}\n`, 'utf8')
      CodexThreadNames.cache.delete(path)
      return true
    } catch {
      return false
    }
  }

  static watchTarget(homeDir: string): SessionTitleWatchTarget {
    return { dir: join(homeDir, '.codex'), base: CodexThreadNames.indexFile }
  }

  static invalidate(): void {
    CodexThreadNames.cache.clear()
  }

  private static indexPath(homeDir: string): string {
    return join(homeDir, '.codex', CodexThreadNames.indexFile)
  }

  private static load(path: string): ReadonlyMap<string, string> {
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(path) } catch { CodexThreadNames.cache.delete(path); return new Map() }
    const cached = CodexThreadNames.cache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.names

    let content: string
    try { content = readFileSync(path, 'utf8') } catch { CodexThreadNames.cache.delete(path); return new Map() }
    const names = new Map<string, string>()
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      let record: SessionIndexRecord
      try { record = JSON.parse(line) as SessionIndexRecord } catch { continue }
      if (typeof record.id !== 'string' || !SESSION_ID_RE.test(record.id)) continue
      if (typeof record.thread_name !== 'string') continue
      const name = record.thread_name.trim()
      if (name) names.set(record.id, name)
      else names.delete(record.id)
    }
    CodexThreadNames.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, names })
    return names
  }

  private static codexHomeForSessionFile(sessionFile: string): string | null {
    let dir = dirname(sessionFile)
    while (true) {
      if (basename(dir).toLowerCase() === 'sessions') return dirname(dir)
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  private static sessionIdForFile(sessionFile: string): string | null {
    return basename(sessionFile).match(CodexThreadNames.rolloutIdPattern)?.[1] ?? null
  }
}
