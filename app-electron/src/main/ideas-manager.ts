import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logError } from './logger'
import type { Idea } from '../../../core/types/ideas.js'
import { getJamatPaths } from './jamat-paths'

/**
 * Per-window JSON store for the Ideas panel. Each window (named or unnamed group) gets its own file
 * in the portable config-dir; no cross-window sync. Single writer per file because each window only
 * writes its own.
 *
 * File path: `<config-dir>/ideas-<windowId>.json`.
 * Schema: `Idea[]`. See `core/types/ideas.ts`.
 */

const STORAGE_DIR = getJamatPaths().ideasDir

function safeWindowId(windowId: string): string {
  // Only allow letters, digits, hyphens, and underscores — keeps the
  // path inside STORAGE_DIR even when the caller passes a weird id.
  return windowId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'default'
}

function pathFor(windowId: string): string {
  return join(STORAGE_DIR, `ideas-${safeWindowId(windowId)}.json`)
}

function ensureDir(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true })
  }
}

function isValidIdea(x: unknown): x is Idea {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.id === 'string'
    && typeof o.title === 'string'
    && typeof o.body === 'string'
    && typeof o.category === 'string'
    && typeof o.importance === 'number'
    && o.importance >= 1 && o.importance <= 5
    && typeof o.dueDate === 'string'
    && typeof o.createdAt === 'string'
    && typeof o.updatedAt === 'string'
}

export function loadIdeas(windowId: string): Idea[] {
  const p = pathFor(windowId)
  if (!existsSync(p)) return []
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidIdea)
  } catch (err) {
    try { logError('ideas:load', `${windowId} -> ${err}`) } catch { /* logger requires electron; safe to skip in smoke */ }
    return []
  }
}

export function saveIdeas(windowId: string, ideas: Idea[]): { ok: boolean; error?: string } {
  try {
    ensureDir()
    const p = pathFor(windowId)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(ideas, null, 2), 'utf-8')
    renameSync(tmp, p)
    return { ok: true }
  } catch (err) {
    const msg = String(err)
    try { logError('ideas:save', `${windowId} -> ${msg}`) } catch { /* logger requires electron; safe to skip in smoke */ }
    return { ok: false, error: msg }
  }
}
