/**
 * VCS baseline helpers — git/svn working-copy detection + `<ref> file content`
 * fetch via `child_process.spawnSync`. Native Node only, no external deps.
 *
 * Cache strategy: per (source, repoRoot, ref, fileKey). Invalidated by
 * `.git/HEAD` (git) or `.svn/wc.db` (svn) mtime change. Hard TTL fallback
 * 60s so rebases that land on the same ref don't serve stale content
 * indefinitely.
 *
 * Path conventions: filePaths are absolute. Git paths internally use `/`
 * even on Windows — we convert before passing to `git show`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { fileKey } from './diff-compose.js'
import type {
  BaselineFetch,
  BaselineSource,
  VcsDetection,
  VcsRepoInfo,
} from '../types/file-diff.js'

const SPAWN_TIMEOUT_MS = 5000
const TTL_MS = 60_000
const HISTORY_LIMIT = 5

interface CacheEntry {
  result: BaselineFetch
  refMtime: number | null
  fetchedAt: number
}

const baselineCache = new Map<string, CacheEntry>()
const rootCache = new Map<string, VcsRepoInfo | null>()

// ────────────────────────────────────────────────────────────────────────────
// Path utilities
// ────────────────────────────────────────────────────────────────────────────

function dirOf(filePath: string): string {
  try {
    return statSync(filePath).isDirectory() ? filePath : dirname(filePath)
  } catch {
    return dirname(filePath)
  }
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

function refMtimeFor(source: BaselineSource, repoRoot: string): number | null {
  const marker = source === 'git' ? `${repoRoot}${sep}.git${sep}HEAD` : `${repoRoot}${sep}.svn${sep}wc.db`
  try {
    return statSync(marker).mtimeMs
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Repo detection
// ────────────────────────────────────────────────────────────────────────────

export function findFirstAncestorWithMarker(startDir: string, marker: string): string | null {
  let cur = startDir
  while (true) {
    if (existsSync(`${cur}${sep}${marker}`)) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/**
 * Topmost ancestor of `startDir` whose parent chain still has `.svn/`. Modern
 * svn (1.7+) keeps `.svn` only at the WC root; legacy svn 1.6 puts it in
 * every subdir. Walking up while the parent also has `.svn/` finds the actual
 * root either way. Returns null when no `.svn/` is found at all.
 */
export function findTopmostSvnAncestor(startDir: string): string | null {
  const first = findFirstAncestorWithMarker(startDir, '.svn')
  if (!first) return null
  let cur = first
  while (true) {
    const parent = dirname(cur)
    if (parent === cur) break
    if (!existsSync(`${parent}${sep}.svn`)) break
    cur = parent
  }
  return cur
}

/** First ancestor that contains `.git`. Returns null when none. */
export function findGitRoot(filePath: string): string | null {
  if (!isAbsolute(filePath)) return null
  const dir = dirOf(filePath)
  const key = `git:${dir}`
  if (rootCache.has(key)) return rootCache.get(key)?.repoRoot ?? null
  const root = findFirstAncestorWithMarker(dir, '.git')
  rootCache.set(key, root ? { source: 'git', repoRoot: root } : null)
  return root
}

/**
 * Topmost svn working-copy ancestor. Modern svn (1.7+) puts `.svn` only at
 * the WC root; older svn (1.6) puts it in every subdir. We walk up while the
 * parent still has `.svn`, so both layouts converge on the actual root.
 */
export function findSvnRoot(filePath: string): string | null {
  if (!isAbsolute(filePath)) return null
  const dir = dirOf(filePath)
  const key = `svn:${dir}`
  if (rootCache.has(key)) return rootCache.get(key)?.repoRoot ?? null

  const root = findTopmostSvnAncestor(dir)
  rootCache.set(key, root ? { source: 'svn', repoRoot: root } : null)
  return root
}

export function detectVcs(filePath: string): VcsDetection {
  const git = findGitRoot(filePath)
  const svn = findSvnRoot(filePath)
  return {
    git: git ? { source: 'git', repoRoot: git } : null,
    svn: svn ? { source: 'svn', repoRoot: svn } : null,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cache layer
// ────────────────────────────────────────────────────────────────────────────

function cacheKey(source: BaselineSource, repoRoot: string, ref: string, filePath: string): string {
  return `${source}:${repoRoot}:${ref}:${fileKey(filePath)}`
}

function getCached(source: BaselineSource, repoRoot: string, ref: string, filePath: string): BaselineFetch | null {
  const key = cacheKey(source, repoRoot, ref, filePath)
  const entry = baselineCache.get(key)
  if (!entry) return null
  const now = Date.now()
  if (now - entry.fetchedAt > TTL_MS) return null
  const currentRefMtime = refMtimeFor(source, repoRoot)
  if (currentRefMtime !== entry.refMtime) return null
  return entry.result
}

function putCached(source: BaselineSource, repoRoot: string, ref: string, filePath: string, result: BaselineFetch): void {
  const key = cacheKey(source, repoRoot, ref, filePath)
  baselineCache.set(key, {
    result,
    refMtime: refMtimeFor(source, repoRoot),
    fetchedAt: Date.now(),
  })
}

/** Test-only: clear all VCS caches. */
export function _resetFileDiffVcsCachesForTests(): void {
  baselineCache.clear()
  rootCache.clear()
}

// ────────────────────────────────────────────────────────────────────────────
// Git
// ────────────────────────────────────────────────────────────────────────────

function spawnGit(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const r = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  })
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    error: r.error,
  }
}

function isGitNotInPath(stderr: string, error?: Error): boolean {
  if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return true
  return /not (recognized|found)|command not found/i.test(stderr)
}

/** True when the repo has at least one commit on HEAD. */
function gitHasCommits(repoRoot: string): boolean {
  const r = spawnGit(repoRoot, ['rev-parse', '--verify', 'HEAD'])
  return r.status === 0
}

export function fetchGitBaseline(repoRoot: string, filePath: string, ref: string): BaselineFetch {
  const cached = getCached('git', repoRoot, ref, filePath)
  if (cached) return cached

  if (!gitHasCommits(repoRoot)) {
    const result: BaselineFetch = { content: '', exists: false, timestamp: null }
    putCached('git', repoRoot, ref, filePath, result)
    return result
  }

  const rel = toForwardSlash(relative(repoRoot, filePath))
  const show = spawnGit(repoRoot, ['show', `${ref}:${rel}`])
  if (show.error && isGitNotInPath(show.stderr, show.error)) {
    return { content: '', exists: false, timestamp: null, error: 'git: command not found in PATH' }
  }

  const exists = show.status === 0
  const content = exists ? show.stdout : ''

  // Commit timestamp for this ref (branch-level, not file-level — matches the
  // "since commit X" mental model). Falls back to null if log fails.
  const log = spawnGit(repoRoot, ['log', '-1', '--format=%ct', ref])
  const timestamp = log.status === 0 && log.stdout.trim()
    ? parseInt(log.stdout.trim(), 10) * 1000
    : null

  const result: BaselineFetch = {
    content,
    exists,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  }
  putCached('git', repoRoot, ref, filePath, result)
  return result
}

export interface GitHistoryEntry {
  /** Either 'HEAD' or 'HEAD~N'. */
  ref: string
  shortSha: string
  subject: string
  /** Unix epoch ms. */
  commitDate: number
}

/**
 * Recent branch-level commits (HEAD, HEAD~1, …). Not filtered by file —
 * matches the user-facing mental model of "Since HEAD~N" = "diff working
 * tree against the state N commits ago".
 */
export function listRecentGitHistory(repoRoot: string, limit = HISTORY_LIMIT): GitHistoryEntry[] {
  if (!gitHasCommits(repoRoot)) return []
  const r = spawnGit(repoRoot, ['log', `-n`, String(limit), '--format=%h%x09%ct%x09%s'])
  if (r.status !== 0) return []
  const out: GitHistoryEntry[] = []
  const lines = r.stdout.split(/\r?\n/).filter(l => l.length > 0)
  for (let i = 0; i < lines.length; i++) {
    const [shortSha, ctStr, ...subjParts] = lines[i].split('\t')
    if (!shortSha || !ctStr) continue
    const ct = parseInt(ctStr, 10)
    if (!Number.isFinite(ct)) continue
    out.push({
      ref: i === 0 ? 'HEAD' : `HEAD~${i}`,
      shortSha,
      subject: subjParts.join('\t').slice(0, 80),
      commitDate: ct * 1000,
    })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// SVN
// ────────────────────────────────────────────────────────────────────────────

function spawnSvn(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const r = spawnSync('svn', args, {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
    cwd,
  })
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    error: r.error,
  }
}

function isSvnNotInPath(stderr: string, error?: Error): boolean {
  if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return true
  return /not (recognized|found)|command not found/i.test(stderr)
}

export function fetchSvnBaseline(repoRoot: string, filePath: string, rev = 'BASE'): BaselineFetch {
  const cached = getCached('svn', repoRoot, rev, filePath)
  if (cached) return cached

  // `--` separates options from operands so a path starting with `-`
  // can't be parsed as an svn option.
  const cat = spawnSvn(['cat', '-r', rev, '--', filePath], repoRoot)
  if (cat.error && isSvnNotInPath(cat.stderr, cat.error)) {
    return { content: '', exists: false, timestamp: null, error: 'svn: command not found in PATH' }
  }

  const exists = cat.status === 0
  const content = exists ? cat.stdout : ''

  // `svn info --show-item last-changed-date <path>` returns ISO timestamp.
  // Falls back to null if info fails (file unversioned, network down for
  // server-required ops, etc).
  let timestamp: number | null = null
  const info = spawnSvn(['info', '--show-item', 'last-changed-date', '--', filePath], repoRoot)
  if (info.status === 0 && info.stdout.trim()) {
    const parsed = Date.parse(info.stdout.trim())
    if (Number.isFinite(parsed)) timestamp = parsed
  }

  const result: BaselineFetch = { content, exists, timestamp }
  putCached('svn', repoRoot, rev, filePath, result)
  return result
}

// ────────────────────────────────────────────────────────────────────────────
// Source preference (git vs svn — newer wins)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pick the VCS source with the newer baseline timestamp for a file. Used
 * to decide which "Since last commit" option to default to when both git
 * and svn happen to track the same path (rare — typically only legacy
 * mixed-repo edge cases).
 *
 * Returns null when neither VCS finds the file or both subprocesses fail.
 */
export function preferVcsForFile(detection: VcsDetection, filePath: string): BaselineSource | null {
  const { git, svn } = detection
  if (git && !svn) return 'git'
  if (svn && !git) return 'svn'
  if (!git && !svn) return null

  const gitTs = git ? fetchGitBaseline(git.repoRoot, filePath, 'HEAD').timestamp : null
  const svnTs = svn ? fetchSvnBaseline(svn.repoRoot, filePath).timestamp : null
  if (gitTs === null && svnTs === null) return git ? 'git' : 'svn'
  if (gitTs === null) return 'svn'
  if (svnTs === null) return 'git'
  return gitTs >= svnTs ? 'git' : 'svn'
}
