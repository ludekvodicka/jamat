import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { isAgentId, type AgentId } from '../../../core/types/contracts.js'
import { logError } from './logger'
import { getJamatPaths } from './jamat-paths'
import { registerHandler } from '../shared/typed-ipc'
import { publish } from './streams'
import { CodexRateLimitClient } from './codex-rate-limit-client'
import type { AppConfig, UsageCache, AgentUsageSnapshot, UsageWindow } from '../shared/types'

const POLL_INTERVAL = 10 * 60 * 1000
const CACHE_MAX_AGE = 10 * 60 * 1000
const FETCH_TIMEOUT = 10_000
const CODEX_NOTIFICATION_COOLDOWN = 5_000

const cachePath = getJamatPaths().usageCache
const cacheTmpPath = join(getJamatPaths().configDir, 'usage-cache.tmp.json')

let pollInterval: ReturnType<typeof setInterval> | null = null
let isFetchingClaude = false
let storedOrgId: string | null = null
let storedSessionKey: string | null = null
let storedConfigPath: string | null = null
let codexClient: CodexRateLimitClient | null = null
let codexSnapshot: AgentUsageSnapshot | null = null
let codexRefreshPromise: Promise<AgentUsageSnapshot> | null = null
let codexLastFetch = 0

function readClaudeCache(): UsageCache | null {
  try {
    if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch {}
  return null
}

function writeClaudeCache(cache: UsageCache): void {
  try {
    writeFileSync(cacheTmpPath, JSON.stringify(cache, null, 2), 'utf-8')
    renameSync(cacheTmpPath, cachePath)
  } catch (error) {
    logError('usage', `Failed to write cache: ${errorMessage(error)}`)
  }
}

function claudeWindow(durationMinutes: number, utilization: number, resetsAt: string): UsageWindow {
  return { durationMinutes, usedPercent: utilization, resetsAt: resetsAt || null }
}

function toClaudeSnapshot(cache: UsageCache): AgentUsageSnapshot {
  const windows: UsageWindow[] = []
  if (cache.data) {
    windows.push(claudeWindow(300, cache.data.five_hour.utilization, cache.data.five_hour.resets_at))
    windows.push(claudeWindow(10080, cache.data.seven_day.utilization, cache.data.seven_day.resets_at))
    if (cache.data.seven_day_fable)
      windows.push({ ...claudeWindow(10080, cache.data.seven_day_fable.utilization, cache.data.seven_day_fable.resets_at), model: 'fable' })
  }
  return { agent: 'claude', fetchedAt: cache.fetchedAt, windows, ...(cache.error ? { error: cache.error } : {}) }
}

function broadcastUsage(snapshot: AgentUsageSnapshot): void {
  publish('usage:update', snapshot)
}

function fetchClaudeUsage(orgId: string, sessionKey: string): UsageCache['data'] {
  const out = execSync(
    `curl -s "https://claude.ai/api/organizations/${orgId}/usage" ` +
    `-H "accept: application/json" ` +
    `-H "content-type: application/json" ` +
    `-H "cookie: sessionKey=${sessionKey}"`,
    { timeout: FETCH_TIMEOUT, encoding: 'utf-8' },
  )
  const raw = JSON.parse(out)
  if (!raw?.five_hour || !raw?.seven_day) {
    const reason = typeof raw?.error === 'string' ? raw.error : raw?.error?.message
    throw new Error(reason ?? 'the usage API returned no data — the session key is missing or expired')
  }
  const fable = fableWeeklyFromLimits(raw)
  return {
    five_hour: { utilization: raw.five_hour.utilization ?? 0, resets_at: raw.five_hour.resets_at ?? '' },
    seven_day: { utilization: raw.seven_day.utilization ?? 0, resets_at: raw.seven_day.resets_at ?? '' },
    ...(fable && { seven_day_fable: fable }),
  }
}

// The Fable weekly cap lives only in the usage API's `limits[]` (a `weekly_scoped` entry whose
// scope.model.display_name is "Fable") — the flat `seven_day_*` fields stay null for it.
function fableWeeklyFromLimits(raw: unknown): { utilization: number; resets_at: string } | null {
  const limits = (raw as { limits?: unknown })?.limits
  if (!Array.isArray(limits)) return null
  for (const limit of limits) {
    if (limit?.kind !== 'weekly_scoped') continue
    if (limit?.scope?.model?.display_name !== 'Fable') continue
    if (typeof limit.percent !== 'number') continue
    return { utilization: limit.percent, resets_at: typeof limit.resets_at === 'string' ? limit.resets_at : '' }
  }
  return null
}

function refreshClaudeUsage(orgId: string, sessionKey: string, force = false): UsageCache | null {
  if (isFetchingClaude) return readClaudeCache()
  isFetchingClaude = true
  try {
    const existing = readClaudeCache()
    if (!force && existing && !existing.error && Date.now() - existing.fetchedAt < CACHE_MAX_AGE) {
      broadcastUsage(toClaudeSnapshot(existing))
      return existing
    }
    const cache: UsageCache = { fetchedAt: Date.now(), data: fetchClaudeUsage(orgId, sessionKey) }
    writeClaudeCache(cache)
    broadcastUsage(toClaudeSnapshot(cache))
    return cache
  } catch (error) {
    const existing = readClaudeCache()
    const cache: UsageCache = { fetchedAt: Date.now(), data: existing?.data ?? null, error: errorMessage(error) }
    writeClaudeCache(cache)
    broadcastUsage(toClaudeSnapshot(cache))
    logError('usage', `Claude fetch failed: ${errorMessage(error)}`)
    return cache
  } finally {
    isFetchingClaude = false
  }
}

function ensureCodexClient(): CodexRateLimitClient {
  if (!codexClient) {
    codexClient = new CodexRateLimitClient(() => {
      if (Date.now() - codexLastFetch >= CODEX_NOTIFICATION_COOLDOWN) void refreshCodexUsage()
    })
  }
  return codexClient
}

function refreshCodexUsage(): Promise<AgentUsageSnapshot> {
  if (codexRefreshPromise) return codexRefreshPromise
  const request = refreshCodexUsageNow()
  const tracked = request.then(
    (snapshot) => { codexRefreshPromise = null; return snapshot },
    (error) => { codexRefreshPromise = null; throw error },
  )
  codexRefreshPromise = tracked
  return tracked
}

async function refreshCodexUsageNow(): Promise<AgentUsageSnapshot> {
  try {
    const windows = await ensureCodexClient().readWindows()
    if (windows.length === 0) throw new Error('Codex returned no rate-limit windows')
    codexSnapshot = { agent: 'codex', fetchedAt: Date.now(), windows }
  } catch (error) {
    codexSnapshot = {
      agent: 'codex',
      fetchedAt: Date.now(),
      windows: codexSnapshot?.windows ?? [],
      error: errorMessage(error),
    }
    logError('usage', `Codex fetch failed: ${errorMessage(error)}`)
  }
  codexLastFetch = codexSnapshot.fetchedAt
  broadcastUsage(codexSnapshot)
  return codexSnapshot
}

async function getAgentUsage(agent: unknown): Promise<AgentUsageSnapshot | null> {
  if (!isAgentId(agent)) throw new Error(`Unknown usage agent: ${JSON.stringify(agent)}`)
  if (agent === 'claude') {
    if (!storedOrgId || !storedSessionKey) return null
    const cache = readClaudeCache() ?? refreshClaudeUsage(storedOrgId, storedSessionKey)
    return cache ? toClaudeSnapshot(cache) : null
  }
  else if (agent === 'codex')
    return refreshCodexUsage()
  else
    throw new Error(`Unknown usage agent: ${JSON.stringify(agent)}`)
}

export function getUsageCache(): Partial<Record<AgentId, AgentUsageSnapshot>> {
  const usage: Partial<Record<AgentId, AgentUsageSnapshot>> = {}
  const claude = storedOrgId && storedSessionKey ? readClaudeCache() : null
  if (claude) usage.claude = toClaudeSnapshot(claude)
  if (codexSnapshot) usage.codex = codexSnapshot
  return usage
}

export async function forceRefreshUsage(): Promise<Partial<Record<AgentId, AgentUsageSnapshot>>> {
  if (storedOrgId && storedSessionKey) refreshClaudeUsage(storedOrgId, storedSessionKey, true)
  await refreshCodexUsage()
  return getUsageCache()
}

function ensurePolling(): void {
  if (storedOrgId && storedSessionKey) refreshClaudeUsage(storedOrgId, storedSessionKey)
  if (!pollInterval) {
    pollInterval = setInterval(() => {
      if (storedOrgId && storedSessionKey) refreshClaudeUsage(storedOrgId, storedSessionKey)
    }, POLL_INTERVAL)
  }
}

export function getUsageCredentials(): { orgId: string; hasSessionKey: boolean } {
  return { orgId: storedOrgId ?? '', hasSessionKey: !!storedSessionKey }
}

export function setUsageCredentials(orgId: string, sessionKey: string): { ok: boolean; error?: string } {
  const trimmedOrg = orgId.trim()
  const effectiveKey = sessionKey.trim() || storedSessionKey || ''
  if (!trimmedOrg || !effectiveKey)
    return { ok: false, error: 'Both Organization ID and Session Key are required' }
  if (!storedConfigPath)
    return { ok: false, error: 'Config path unknown — cannot persist credentials' }

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
  } catch (error) {
    return { ok: false, error: `Failed to write ${overlayPath}: ${errorMessage(error)}` }
  }

  storedOrgId = trimmedOrg
  storedSessionKey = effectiveKey
  try { if (existsSync(cachePath)) unlinkSync(cachePath) } catch {}
  ensurePolling()
  const after = readClaudeCache()
  if (after?.error) return { ok: true, error: `Saved, but the usage fetch failed: ${after.error}` }
  return { ok: true }
}

export function startUsagePolling(config: AppConfig): void {
  storedConfigPath = config.configPath
  registerHandler('usage:get', async (_event, agent) => getAgentUsage(agent))
  registerHandler('usage:get-credentials', async () => getUsageCredentials())
  registerHandler('usage:set-credentials', async (_event, orgId, sessionKey) => setUsageCredentials(orgId, sessionKey))

  if (!config.claudeUsage) return
  storedOrgId = config.claudeUsage.orgId
  storedSessionKey = config.claudeUsage.sessionKey
  ensurePolling()
}

export function stopUsagePolling(): void {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = null
  codexClient?.stop()
  codexClient = null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
