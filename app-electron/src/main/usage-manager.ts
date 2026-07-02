import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { logError } from './logger'
import { getJamatPaths } from './jamat-paths'
import { registerHandler } from '../shared/typed-ipc'
import { publish } from './streams'
import type { AppConfig, UsageCache } from '../shared/types'

const POLL_INTERVAL = 10 * 60 * 1000
const CACHE_MAX_AGE = 10 * 60 * 1000
const FETCH_TIMEOUT = 10_000

const cachePath = getJamatPaths().usageCache
const cacheTmpPath = join(getJamatPaths().configDir, 'usage-cache.tmp.json')

let pollInterval: ReturnType<typeof setInterval> | null = null
let isFetching = false
let storedOrgId: string | null = null
let storedSessionKey: string | null = null
// The loaded config's path — the secret overlay (`*.local.json`) we write credentials into is
// derived from it. Captured in startUsagePolling so set-credentials knows where to persist.
let storedConfigPath: string | null = null

function readCache(): UsageCache | null {
  try {
    if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch {}
  return null
}

function writeCache(cache: UsageCache): void {
  try {
    writeFileSync(cacheTmpPath, JSON.stringify(cache, null, 2), 'utf-8')
    renameSync(cacheTmpPath, cachePath)
  } catch (e: any) {
    logError('usage', `Failed to write cache: ${e.message}`)
  }
}

function broadcastUsage(cache: UsageCache): void {
  publish('usage:update', cache)
}

function fetchUsage(orgId: string, sessionKey: string): UsageCache['data'] {
  const out = execSync(
    `curl -s "https://claude.ai/api/organizations/${orgId}/usage" ` +
    `-H "accept: application/json" ` +
    `-H "content-type: application/json" ` +
    `-H "cookie: sessionKey=${sessionKey}"`,
    { timeout: FETCH_TIMEOUT, encoding: 'utf-8' }
  )
  const raw = JSON.parse(out)
  return {
    five_hour: { utilization: raw.five_hour?.utilization ?? 0, resets_at: raw.five_hour?.resets_at ?? '' },
    seven_day: { utilization: raw.seven_day?.utilization ?? 0, resets_at: raw.seven_day?.resets_at ?? '' },
    ...(raw.seven_day_sonnet && { seven_day_sonnet: { utilization: raw.seven_day_sonnet.utilization, resets_at: raw.seven_day_sonnet.resets_at } }),
    ...(raw.seven_day_omelette && { seven_day_omelette: { utilization: raw.seven_day_omelette.utilization, resets_at: raw.seven_day_omelette.resets_at } })
  }
}

function refreshUsage(orgId: string, sessionKey: string): void {
  if (isFetching) return
  isFetching = true
  try {
    const existing = readCache()
    if (existing && !existing.error && Date.now() - existing.fetchedAt < CACHE_MAX_AGE) {
      broadcastUsage(existing)
      return
    }
    const data = fetchUsage(orgId, sessionKey)
    const cache: UsageCache = { fetchedAt: Date.now(), data }
    writeCache(cache)
    broadcastUsage(cache)
  } catch (e: any) {
    const existing = readCache()
    const cache: UsageCache = { fetchedAt: Date.now(), data: existing?.data ?? null, error: e.message }
    writeCache(cache)
    broadcastUsage(cache)
    logError('usage', `Fetch failed: ${e.message}`)
  } finally {
    isFetching = false
  }
}

export function getUsageCache(): UsageCache | null {
  return readCache()
}

export function forceRefreshUsage(): UsageCache | null {
  if (!storedOrgId || !storedSessionKey) return readCache()
  const data = fetchUsage(storedOrgId, storedSessionKey)
  const cache: UsageCache = { fetchedAt: Date.now(), data }
  writeCache(cache)
  broadcastUsage(cache)
  return cache
}

// Kick an initial refresh (if creds are set) and ensure the poll interval is running. Safe to call
// repeatedly — the interval reads the *stored* creds, so a later credential change takes effect
// without rebuilding it. Used at boot and after set-credentials (which may be the first time creds
// exist on a config that booted without a claudeUsage block).
function ensurePolling(): void {
  if (storedOrgId && storedSessionKey) {
    try { refreshUsage(storedOrgId, storedSessionKey) } catch {}
  }
  if (!pollInterval) {
    pollInterval = setInterval(() => {
      if (storedOrgId && storedSessionKey) {
        try { refreshUsage(storedOrgId, storedSessionKey) } catch {}
      }
    }, POLL_INTERVAL)
  }
}

export function getUsageCredentials(): { orgId: string; hasSessionKey: boolean } {
  // Never returns the session key itself — only whether one is set. The secret never crosses
  // back to the renderer; the Settings field shows "leave blank to keep current" instead.
  return { orgId: storedOrgId ?? '', hasSessionKey: !!storedSessionKey }
}

export function setUsageCredentials(orgId: string, sessionKey: string): { ok: boolean; error?: string } {
  const trimmedOrg = orgId.trim()
  // Blank key = keep the existing one (the UI shows a "leave blank to keep current" placeholder).
  const effectiveKey = sessionKey.trim() || storedSessionKey || ''
  if (!trimmedOrg || !effectiveKey) {
    return { ok: false, error: 'Both Organization ID and Session Key are required' }
  }
  if (!storedConfigPath) {
    return { ok: false, error: 'Config path unknown — cannot persist credentials' }
  }

  // Persist into the gitignored secret overlay (`config-<user>.local.json`), preserving any other
  // keys it already holds. Atomic via tmp + rename, matching writeCache.
  const overlayPath = storedConfigPath.replace(/\.json$/i, '.local.json')
  try {
    let overlay: Record<string, unknown> = {}
    if (existsSync(overlayPath)) {
      try { overlay = JSON.parse(readFileSync(overlayPath, 'utf-8')) } catch {}
    }
    overlay.claudeUsage = { orgId: trimmedOrg, sessionKey: effectiveKey }
    const tmp = `${overlayPath}.tmp`
    writeFileSync(tmp, JSON.stringify(overlay, null, 2), 'utf-8')
    renameSync(tmp, overlayPath)
  } catch (e: any) {
    return { ok: false, error: `Failed to write ${overlayPath}: ${e.message}` }
  }

  storedOrgId = trimmedOrg
  storedSessionKey = effectiveKey
  // Drop the cache so the next fetch uses the new creds instead of serving the still-fresh old
  // window, then refresh + ensure the interval is running.
  try { if (existsSync(cachePath)) unlinkSync(cachePath) } catch {}
  ensurePolling()
  const after = readCache()
  if (after?.error) return { ok: true, error: `Saved, but the usage fetch failed: ${after.error}` }
  return { ok: true }
}

export function startUsagePolling(config: AppConfig): void {
  storedConfigPath = config.configPath
  // Register unconditionally so the renderer's invoke('usage:get') never throws
  // "No handler registered" — even on configs without a claudeUsage block
  // (e.g. config-<user>.json). Returns the (possibly empty) cache.
  registerHandler('usage:get', async () => readCache())
  registerHandler('usage:get-credentials', async () => getUsageCredentials())
  registerHandler('usage:set-credentials', async (_e, orgId, sessionKey) => setUsageCredentials(orgId, sessionKey))

  if (!config.claudeUsage) return
  storedOrgId = config.claudeUsage.orgId
  storedSessionKey = config.claudeUsage.sessionKey
  ensurePolling()
}

export function stopUsagePolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}
