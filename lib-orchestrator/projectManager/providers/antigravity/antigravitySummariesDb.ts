import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { PathCompare } from '../../../shared/pathCompare'

export interface AntigravityConversationSummary {
  conversationId: string
  title: string | null
  preview: string | null
  createdAt: number
  lastModifiedAt: number
  workspacePaths: readonly string[]
  active: boolean
  parentConversationId: string | null
  nestingDepth: number
  agentName: string | null
}

/**
 * Read-only accessor for Antigravity CLI's `<home>/conversation_summaries.db`.
 *
 * Never writes to the database (the `agy` CLI/daemon may hold it open in WAL mode) and degrades
 * cleanly to empty results when the database does not exist or cannot be opened.
 */
export class AntigravitySummariesDb {
  private static readonly fileNameConst = 'conversation_summaries.db'
  private static readonly idPatternConst = /^[A-Za-z0-9_-]{1,64}$/

  static fileOf(antigravityHome: string): string {
    return join(antigravityHome, AntigravitySummariesDb.fileNameConst)
  }

  static statKey(antigravityHome: string): string | null {
    try {
      const file = AntigravitySummariesDb.fileOf(antigravityHome)
      const info = statSync(file)
      if (!info.isFile()) return null
      let wal = 'none'
      try {
        const walInfo = statSync(`${file}-wal`)
        if (walInfo.isFile()) wal = `${walInfo.mtimeMs}:${walInfo.size}`
      }
      catch { /* no WAL file */ }
      return `${info.mtimeMs}:${info.size}|${wal}`
    }
    catch { return null }
  }

  static readAll(antigravityHome: string): AntigravityConversationSummary[] {
    const file = AntigravitySummariesDb.fileOf(antigravityHome)
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(file, { readOnly: true })
      const rows = db.prepare(
        'SELECT conversation_id, title, preview, last_modified_time, last_user_input_time, '
        + 'workspace_uris, status, not_fully_idle, parent_conversation_id, nesting_depth, agent_name '
        + 'FROM conversation_summaries',
      ).all() as Record<string, unknown>[]
      const out: AntigravityConversationSummary[] = []
      for (const row of rows) {
        const conversationId = typeof row['conversation_id'] === 'string' ? row['conversation_id'] : ''
        if (!AntigravitySummariesDb.idPatternConst.test(conversationId)) continue
        const lastModifiedAt = AntigravitySummariesDb.parseTime(row['last_modified_time'])
        const lastInputAt = AntigravitySummariesDb.parseTime(row['last_user_input_time'])
        const title = AntigravitySummariesDb.trimmed(row['title'])
        const preview = AntigravitySummariesDb.trimmed(row['preview'])
        const parentRaw = AntigravitySummariesDb.trimmed(row['parent_conversation_id'])
        const parentConversationId = parentRaw !== null && AntigravitySummariesDb.idPatternConst.test(parentRaw)
          ? parentRaw
          : null
        const nestingDepth = typeof row['nesting_depth'] === 'number' && Number.isSafeInteger(row['nesting_depth'])
          ? row['nesting_depth']
          : 0
        const status = typeof row['status'] === 'string' ? row['status'] : ''
        const notFullyIdle = row['not_fully_idle'] === 1 || row['not_fully_idle'] === true
        out.push({
          conversationId,
          title,
          preview,
          createdAt: lastInputAt > 0 ? Math.min(lastInputAt, lastModifiedAt || lastInputAt) : lastModifiedAt,
          lastModifiedAt: lastModifiedAt || lastInputAt,
          workspacePaths: AntigravitySummariesDb.parseWorkspaces(row['workspace_uris']),
          active: status === 'CASCADE_RUN_STATUS_RUNNING' || notFullyIdle,
          parentConversationId,
          nestingDepth,
          agentName: AntigravitySummariesDb.trimmed(row['agent_name']),
        })
      }
      return out
    }
    catch { return [] }
    finally { try { db?.close() } catch {} }
  }

  /** Depth-1 and depth-2 sub-agent conversations spawned by `parentConversationId`. */
  static childrenOf(antigravityHome: string, parentConversationId: string): AntigravityConversationSummary[] {
    if (!AntigravitySummariesDb.idPatternConst.test(parentConversationId)) return []
    const all = AntigravitySummariesDb.readAll(antigravityHome)
    const depth1 = all.filter((row) => row.parentConversationId === parentConversationId)
    if (depth1.length === 0) return []
    const depth1Ids = new Set(depth1.map((row) => row.conversationId))
    const depth2 = all.filter((row) => row.parentConversationId !== null && depth1Ids.has(row.parentConversationId))
    return [...depth1, ...depth2]
  }

  /** Maps `conversationId -> primary workspace path` for transcripts with a recorded workspace URI. */
  static workspaceMap(antigravityHome: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const row of AntigravitySummariesDb.readAll(antigravityHome))
      if (row.workspacePaths.length > 0) map.set(row.conversationId, row.workspacePaths[0]!)
    return map
  }

  /** Every conversation (top-level and nested children) bound to `projectDir`. */
  static conversationsForProject(antigravityHome: string, projectDir: string): AntigravityConversationSummary[] {
    const target = PathCompare.comparable(projectDir)
    const all = AntigravitySummariesDb.readAll(antigravityHome)
    const direct = all.filter((row) =>
      row.workspacePaths.some((path) => PathCompare.comparable(path) === target))
    const ids = new Set(direct.map((row) => row.conversationId))
    let grew = true
    while (grew) {
      grew = false
      for (const row of all)
        if (!ids.has(row.conversationId) && row.parentConversationId !== null && ids.has(row.parentConversationId)) {
          ids.add(row.conversationId)
          direct.push(row)
          grew = true
        }
    }
    return direct
  }

  private static parseWorkspaces(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw.trim().length === 0) return []
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { return [] }
    if (!Array.isArray(parsed)) return []
    const paths: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item.trim().length === 0) continue
      const converted = AntigravitySummariesDb.uriToPath(item.trim())
      if (converted !== null) paths.push(converted)
    }
    return paths
  }

  private static uriToPath(uri: string): string | null {
    if (!uri.startsWith('file:')) return uri
    try { return fileURLToPath(uri) }
    catch {
      const stripped = uri.replace(/^file:\/\//i, '')
      return /^\/[A-Za-z]:\//.test(stripped) ? stripped.slice(1) : stripped || null
    }
  }

  private static parseTime(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string' || value.trim().length === 0) return 0
    const normalized = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
    const parsed = Date.parse(normalized)
    return Number.isFinite(parsed) ? parsed : 0
  }

  private static trimmed(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const text = value.trim()
    return text.length > 0 ? text : null
  }
}
