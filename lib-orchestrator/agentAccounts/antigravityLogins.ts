import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RateAccountState, RateWindow } from '../rateMonitor/rateMonitorApi.types'
import { RateMonitorLimits } from '../rateMonitor/rateMonitorLimits'
import { ErrnoCode } from '../shared/errnoCode'
import { JsonShape } from '../shared/jsonShape'
import { Slug } from '../shared/slug'
import { AccountProblem } from './accountProblem'
import { AntigravityIdentityProbe } from './antigravity/antigravityIdentityProbe'
import { WindowsAntigravityKeyring, type AntigravityKeyringInspect } from './antigravity/windowsAntigravityKeyring'
import type { AntigravityLoginsView, AntigravitySlotQuota, AntigravitySwitchResult } from './antigravityLoginsApi.types'

export type AntigravityKeyringPort = Pick<
  WindowsAntigravityKeyring,
  'available' | 'unavailableReason' | 'inspect' | 'store' | 'activate' | 'clear' | 'remove'
>

interface QuotaCacheFile {
  schemaVersion: 1
  switchedAt: number
  slots: Record<string, AntigravitySlotQuota>
}

interface LoginWatch {
  sessionId: string
  deadline: number
  checking: boolean
  seenPresent: boolean
}

export interface AntigravityStoppedSession {
  readonly sessionId: string
  readonly title: string
}

export interface AntigravityLoginsDeps {
  keyring: AntigravityKeyringPort
  accountFile: string
  quotaFile?: string
  runningSessionCount(): number
  reopenableSessionCount?(): number
  stopRunningSessions?: () => Promise<{ stopped: readonly AntigravityStoppedSession[]; failed: readonly string[] }>
  reopenSessions?: (sessions: readonly AntigravityStoppedSession[]) => Promise<AntigravitySwitchResult>
  rates?: () => readonly RateAccountState[]
  resetRates?: (switchedAt: number) => void
  openLogin?: () => Promise<{ sessionId: string }>
  loginResult?: (sessionId: string) => { ended: false } | { ended: true; exitCode: number | null }
  onChanged(): void
  now?: () => number
}

/**
 * Saves, clears, starts sign-in for, and switches the single Antigravity CLI login held in
 * Windows Credential Manager (`gemini:antigravity`).
 */
export class AntigravityLogins {
  private static readonly maxLabelLengthConst = 80
  private static readonly loginWatchIntervalMsConst = 3_000
  private static readonly loginWatchTimeoutMsConst = 15 * 60_000

  private readonly keyring: AntigravityKeyringPort
  private readonly accountFile: string
  private readonly quotaFile: string | undefined
  private readonly runningSessionCount: () => number
  private readonly reopenableSessionCount: () => number
  private readonly stopRunningSessions: (() => Promise<{ stopped: readonly AntigravityStoppedSession[]; failed: readonly string[] }>) | undefined
  private readonly reopenSessions: ((sessions: readonly AntigravityStoppedSession[]) => Promise<AntigravitySwitchResult>) | undefined
  private readonly rates: (() => readonly RateAccountState[]) | undefined
  private readonly resetRates: ((switchedAt: number) => void) | undefined
  private readonly openLogin: (() => Promise<{ sessionId: string }>) | undefined
  private readonly loginResult: ((sessionId: string) => { ended: false } | { ended: true; exitCode: number | null }) | undefined
  private readonly onChanged: () => void
  private readonly now: () => number
  private readonly identityProbe = new AntigravityIdentityProbe()
  private pending: Promise<unknown> = Promise.resolve()
  private quotaCache: QuotaCacheFile | null = null
  private loginWatch: LoginWatch | null = null
  private loginTimer: ReturnType<typeof setInterval> | null = null
  private capturingRates = false
  // Every keyring call starts PowerShell. Rate ticks read this copy; list() and every keyring write
  // replace or drop it, and a read that started before a write never stores its result.
  private inspected: AntigravityKeyringInspect | null = null
  private keyringGeneration = 0
  private lastRateCapturedAt: number | null = null

  constructor(deps: AntigravityLoginsDeps) {
    this.keyring = deps.keyring
    this.accountFile = deps.accountFile
    this.quotaFile = deps.quotaFile
    this.runningSessionCount = deps.runningSessionCount
    this.reopenableSessionCount = deps.reopenableSessionCount ?? (() => 0)
    this.stopRunningSessions = deps.stopRunningSessions
    this.reopenSessions = deps.reopenSessions
    this.rates = deps.rates
    this.resetRates = deps.resetRates
    this.openLogin = deps.openLogin
    this.loginResult = deps.loginResult
    this.onChanged = deps.onChanged
    this.now = deps.now ?? Date.now
  }

  /** The Windows Credential Manager keyring; `assemblyDirectory` keeps its compiled helper. */
  static windowsKeyring(assemblyDirectory: string): AntigravityKeyringPort {
    return new WindowsAntigravityKeyring({ assemblyDirectory })
  }

  async list(): Promise<AntigravityLoginsView> {
    const now = this.now()
    const runningSessionCount = this.runningSessionCount()
    const reopenableSessionCount = this.reopenableSessionCount()
    const loginInProgress = this.loginWatch !== null
    if (!this.keyring.available)
      return {
        available: false,
        unavailableReason: this.keyring.unavailableReason,
        currentPresent: false,
        activeSlotId: null,
        currentEmail: null,
        currentPlanTier: null,
        runningSessionCount,
        reopenableSessionCount,
        loginInProgress,
        capturedAt: now,
        logins: [],
      }
    const [inspected, identity, cache] = await Promise.all([
      this.readKeyring(),
      this.readObservedIdentity(),
      this.loadQuotaCache(),
    ])
    const currentEmail = inspected.present ? identity.email : null
    const currentPlanTier = inspected.present ? identity.planTier : null
    const activeSlotId = AntigravityLogins.resolveActiveSlotId(inspected, currentEmail)
    if (activeSlotId !== null) await this.captureCurrentQuota(cache, activeSlotId)
    const logins = [...inspected.slots]
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id))
      .map(slot => {
        const stored = cache.slots[slot.id] ?? null
        return {
          id: slot.id,
          label: slot.label,
          email: slot.email,
          planTier: slot.planTier,
          savedAt: slot.savedAt,
          active: slot.id === activeSlotId,
          quota: stored === null ? null : AntigravityLogins.projectQuota(stored, now),
        }
      })
    return {
      available: true,
      unavailableReason: null,
      currentPresent: inspected.present,
      activeSlotId,
      currentEmail,
      currentPlanTier,
      runningSessionCount,
      reopenableSessionCount,
      loginInProgress,
      capturedAt: now,
      logins,
    }
  }

  async store(label: string): Promise<{ slotId: string }> {
    const cleanLabel = AntigravityLogins.validateLabel(label)
    return this.serialize(async () => {
      this.requireAvailable()
      const inspected = await this.readKeyring()
      if (!inspected.present)
        throw new AccountProblem('No current Antigravity login found in Windows Credential Manager')
      const duplicate = inspected.slots.find(slot => slot.label.toLowerCase() === cleanLabel.toLowerCase())
      if (duplicate)
        throw new AccountProblem(`A saved Antigravity login named "${duplicate.label}" already exists`)
      const slotId = `${Slug.of(cleanLabel) || 'login'}-${randomBytes(4).toString('hex')}`
      const observed = await this.readObservedIdentity()
      await this.writeKeyring(() => this.keyring.store(slotId, {
        label: cleanLabel,
        email: observed.email,
        planTier: observed.planTier,
        savedAt: this.now(),
      }))
      const cache = await this.loadQuotaCache()
      await this.captureCurrentQuota(cache, slotId)
      this.onChanged()
      return { slotId }
    })
  }

  async update(slotId: string): Promise<void> {
    WindowsAntigravityKeyring.assertSlotId(slotId)
    return this.serialize(async () => {
      this.requireAvailable()
      const inspected = await this.readKeyring()
      const existing = inspected.slots.find(slot => slot.id === slotId)
      if (!existing) throw new AccountProblem('Saved Antigravity login not found')
      if (!inspected.present)
        throw new AccountProblem('No current Antigravity login found in Windows Credential Manager')
      const observed = await this.readObservedIdentity()
      const sameBlob = inspected.currentHash !== null && inspected.currentHash === existing.hash
      await this.writeKeyring(() => this.keyring.store(slotId, {
        label: existing.label,
        email: observed.email ?? (sameBlob ? existing.email : null),
        planTier: observed.planTier ?? (sameBlob ? existing.planTier : null),
        savedAt: this.now(),
      }))
      const cache = await this.loadQuotaCache()
      await this.captureCurrentQuota(cache, slotId)
      this.onChanged()
    })
  }

  async clear(): Promise<void> {
    return this.serialize(async () => {
      this.requireAvailable()
      const [inspected, observed, cache] = await Promise.all([
        this.readKeyring(),
        this.readObservedIdentity(),
        this.loadQuotaCache(),
      ])
      const previousActive = AntigravityLogins.resolveActiveSlotId(inspected, inspected.present ? observed.email : null)
      if (previousActive !== null) await this.captureCurrentQuota(cache, previousActive)
      await this.writeKeyring(() => this.keyring.clear())
      await this.deleteObservedIdentity()
      cache.switchedAt = this.now()
      await this.saveQuotaCache(cache)
      this.resetRates?.(cache.switchedAt)
      this.onChanged()
    })
  }

  async login(): Promise<{ sessionId: string }> {
    return this.serialize(async () => {
      this.requireAvailable()
      if (!this.openLogin) throw new AccountProblem('Antigravity login terminal is not available')
      const inspected = await this.readKeyring()
      if (inspected.present)
        throw new AccountProblem('Clear the current login before starting a new login (store it first if you want to keep it)')
      const opened = await this.openLogin()
      this.startLoginWatch(opened.sessionId)
      this.onChanged()
      return opened
    })
  }

  async switchTo(slotId: string, options?: { reopenRunning?: boolean }): Promise<AntigravitySwitchResult> {
    WindowsAntigravityKeyring.assertSlotId(slotId)
    return this.serialize(async () => {
      this.requireAvailable()
      const [inspected, observed, cache] = await Promise.all([
        this.readKeyring(),
        this.readObservedIdentity(),
        this.loadQuotaCache(),
      ])
      const slot = inspected.slots.find(item => item.id === slotId)
      if (!slot) throw new AccountProblem('Saved Antigravity login not found')
      const previousActive = AntigravityLogins.resolveActiveSlotId(inspected, inspected.present ? observed.email : null)
      if (previousActive !== null) await this.captureCurrentQuota(cache, previousActive)
      // Stop running Antigravity sessions before writing the new credential: a live `agy` process
      // refreshes its in-memory OAuth token hourly and writes the old account back into `gemini:antigravity`.
      const stopped = options?.reopenRunning && this.stopRunningSessions
        ? await this.stopRunningSessions()
        : { stopped: [] as readonly AntigravityStoppedSession[], failed: [] as readonly string[] }
      await this.writeKeyring(() => this.keyring.activate(slotId))
      if (slot.email !== null) await this.writeObservedIdentity(slot.email, slot.planTier)
      else await this.deleteObservedIdentity()
      cache.switchedAt = this.now()
      await this.saveQuotaCache(cache)
      this.resetRates?.(cache.switchedAt)
      this.stopLoginWatch()
      const reopened = options?.reopenRunning && this.reopenSessions && stopped.stopped.length > 0
        ? await this.reopenSessions(stopped.stopped)
        : { reopened: 0, failed: [] }
      this.onChanged()
      return { reopened: reopened.reopened, failed: [...stopped.failed, ...reopened.failed] }
    })
  }

  /** Timestamp of the most recent Antigravity login switch or clear, or 0 if none was recorded. */
  switchedAt(): number {
    if (this.quotaCache !== null) return this.quotaCache.switchedAt
    if (!this.quotaFile) return 0
    try {
      const parsed = AntigravityLogins.parseQuotaCache(readFileSync(this.quotaFile, 'utf8'))
      if (parsed !== null) {
        this.quotaCache = parsed
        return parsed.switchedAt
      }
    } catch { /* Missing or unreadable cache means no switch has been recorded yet. */ }
    return 0
  }

  async remove(slotId: string): Promise<void> {
    WindowsAntigravityKeyring.assertSlotId(slotId)
    return this.serialize(async () => {
      this.requireAvailable()
      await this.writeKeyring(() => this.keyring.remove(slotId))
      const cache = await this.loadQuotaCache()
      if (Object.prototype.hasOwnProperty.call(cache.slots, slotId)) {
        delete cache.slots[slotId]
        await this.saveQuotaCache(cache)
      }
      this.onChanged()
    })
  }

  sessionsChanged(): void {
    const watch = this.loginWatch
    if (watch === null || watch.checking) return
    const timedOut = this.now() >= watch.deadline
    const ended = this.loginResult ? this.loginResult(watch.sessionId).ended : false
    if (ended || timedOut) {
      this.stopLoginWatch()
      this.onChanged()
      return
    }
    if (!this.keyring.available || watch.seenPresent) return
    watch.checking = true
    void this.readKeyring().then(inspected => {
      if (this.loginWatch !== watch) return
      if (inspected.present) {
        watch.seenPresent = true
        this.onChanged()
      }
    }, () => {}).finally(() => { watch.checking = false })
  }

  /**
   * Remembers the active slot's quota when a new Antigravity reading arrives. It works only with two
   * or more saved logins, because only then is there a slot to switch to whose quota matters. It
   * reads the keyring only when no copy is held: once at start and once after each keyring write.
   */
  ratesChanged(): void {
    if (!this.keyring.available || !this.rates || this.capturingRates) return
    const reading = this.readCurrentRateSnapshot()
    if (reading === null || reading.capturedAt === this.lastRateCapturedAt) return
    this.lastRateCapturedAt = reading.capturedAt
    if (this.inspected !== null && !AntigravityLogins.switchable(this.inspected)) return
    this.capturingRates = true
    void this.serialize(async () => {
      const cache = await this.loadQuotaCache()
      if (cache.switchedAt > 0 && reading.capturedAt <= cache.switchedAt) return
      const held = this.inspected
      const inspected = held ?? await this.readKeyring()
      if (!AntigravityLogins.switchable(inspected)) return
      const observed = await this.readObservedIdentity()
      const activeSlotId = AntigravityLogins.resolveActiveSlotId(inspected, inspected.present ? observed.email : null)
      if (activeSlotId === null) return
      // A held copy misses a login changed outside Jamat; a different observed email shows it. A
      // fresh read that still disagrees is kept, so a stale identity file costs no read per reading.
      const activeEmail = inspected.slots.find(slot => slot.id === activeSlotId)?.email ?? null
      if (activeEmail !== null && observed.email !== null && activeEmail.toLowerCase() !== observed.email.toLowerCase()) {
        if (held !== null) this.forgetKeyring()
        return
      }
      const saved = await this.captureCurrentQuota(cache, activeSlotId)
      if (saved) this.onChanged()
    }).catch(() => {}).finally(() => { this.capturingRates = false })
  }

  stop(): void {
    this.stopLoginWatch()
  }

  private startLoginWatch(sessionId: string): void {
    this.stopLoginWatch()
    this.loginWatch = {
      sessionId,
      deadline: this.now() + AntigravityLogins.loginWatchTimeoutMsConst,
      checking: false,
      seenPresent: false,
    }
    this.loginTimer = setInterval(() => this.sessionsChanged(), AntigravityLogins.loginWatchIntervalMsConst)
    this.loginTimer.unref?.()
  }

  private stopLoginWatch(): void {
    if (this.loginTimer !== null) clearInterval(this.loginTimer)
    this.loginTimer = null
    this.loginWatch = null
  }

  private async readKeyring(): Promise<AntigravityKeyringInspect> {
    const generation = this.keyringGeneration
    const inspected = await this.keyring.inspect()
    if (generation === this.keyringGeneration) this.inspected = inspected
    return inspected
  }

  private async writeKeyring(write: () => Promise<void>): Promise<void> {
    try { await write() }
    finally { this.forgetKeyring() }
  }

  private forgetKeyring(): void {
    this.keyringGeneration += 1
    this.inspected = null
  }

  private static switchable(inspected: AntigravityKeyringInspect): boolean {
    return inspected.slots.length >= 2
  }

  private requireAvailable(): void {
    if (!this.keyring.available)
      throw new AccountProblem(this.keyring.unavailableReason ?? 'Antigravity login switching is not available')
  }

  private readCurrentRateSnapshot(): AntigravitySlotQuota | null {
    const account = this.rates?.().find(item => item.key.agentId === 'antigravity' && item.key.accountId === 'main')
    if (!account) return null
    const state = account.state
    if (state.kind !== 'ok' && state.kind !== 'stale') return null
    if (state.fetchedAt === null) return null
    const windows = state.windows
    const session = windows.find(window => window.durationMinutes === RateMonitorLimits.sessionMinutes && !window.model) ?? null
    const weekly = windows.find(window => window.durationMinutes === RateMonitorLimits.weeklyMinutes && !window.model) ?? null
    if (session === null && weekly === null) return null
    return {
      capturedAt: state.fetchedAt,
      session: session === null ? null : { durationMinutes: session.durationMinutes, usedPercent: session.usedPercent, resetsAt: session.resetsAt },
      weekly: weekly === null ? null : { durationMinutes: weekly.durationMinutes, usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt },
    }
  }

  private async captureCurrentQuota(cache: QuotaCacheFile, slotId: string): Promise<boolean> {
    const reading = this.readCurrentRateSnapshot()
    if (reading === null || (cache.switchedAt > 0 && reading.capturedAt <= cache.switchedAt)) return false
    const previous = cache.slots[slotId]
    if (previous && previous.capturedAt >= reading.capturedAt) return false
    cache.slots[slotId] = reading
    await this.saveQuotaCache(cache)
    return true
  }

  private async loadQuotaCache(): Promise<QuotaCacheFile> {
    if (this.quotaCache !== null) return this.quotaCache
    const empty: QuotaCacheFile = { schemaVersion: 1, switchedAt: 0, slots: {} }
    if (!this.quotaFile) { this.quotaCache = empty; return empty }
    let raw: string
    try { raw = await readFile(this.quotaFile, 'utf8') }
    catch { this.quotaCache = empty; return empty }
    const parsed = AntigravityLogins.parseQuotaCache(raw)
    this.quotaCache = parsed ?? empty
    return this.quotaCache
  }

  private async saveQuotaCache(cache: QuotaCacheFile): Promise<void> {
    this.quotaCache = cache
    if (!this.quotaFile) return
    await mkdir(dirname(this.quotaFile), { recursive: true })
    const temporary = `${this.quotaFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(cache), 'utf8')
      await rename(temporary, this.quotaFile)
    } catch (error) {
      try { await unlink(temporary) } catch {}
      throw error
    }
  }

  private async readObservedIdentity(): Promise<{ email: string | null; planTier: string | null }> {
    const probe = await this.identityProbe.read(this.accountFile)
    if (probe === null) return { email: null, planTier: null }
    switch (probe.kind) {
      case 'logged-in': return { email: probe.identity.label, planTier: probe.rateLimitTier ?? null }
      case 'logged-out':
      case 'failed': return { email: null, planTier: null }
      default: throw new Error(`Unknown identity probe: ${JSON.stringify(probe)}`)
    }
  }

  private async writeObservedIdentity(email: string, planTier: string | null): Promise<void> {
    await mkdir(dirname(this.accountFile), { recursive: true })
    const temporary = `${this.accountFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const payload = JSON.stringify({ schemaVersion: 1, email, ...(planTier === null ? {} : { planTier }) })
    try {
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, this.accountFile)
    } catch (error) {
      try { await unlink(temporary) } catch {}
      throw error
    }
  }

  private async deleteObservedIdentity(): Promise<void> {
    try { await unlink(this.accountFile) }
    catch (error) { if (ErrnoCode.of(error) !== 'ENOENT') throw error }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(action)
    this.pending = next.catch(() => {})
    return next
  }

  static projectQuota(quota: AntigravitySlotQuota, now: number): AntigravitySlotQuota {
    return {
      capturedAt: quota.capturedAt,
      session: quota.session === null ? null : AntigravityLogins.projectWindow(quota.session, now),
      weekly: quota.weekly === null ? null : AntigravityLogins.projectWindow(quota.weekly, now),
    }
  }

  private static projectWindow(window: RateWindow, now: number): RateWindow {
    if (window.resetsAt === null) return window
    const resetAt = Date.parse(window.resetsAt)
    if (!Number.isFinite(resetAt) || resetAt > now) return window
    const periodMs = window.durationMinutes * 60_000
    if (periodMs <= 0) return { durationMinutes: window.durationMinutes, usedPercent: 0, resetsAt: null }
    const steps = Math.floor((now - resetAt) / periodMs) + 1
    return {
      durationMinutes: window.durationMinutes,
      usedPercent: 0,
      resetsAt: new Date(resetAt + steps * periodMs).toISOString(),
    }
  }

  private static parseQuotaCache(raw: string): QuotaCacheFile | null {
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { return null }
    const record = JsonShape.record(parsed)
    if (record === null || record.schemaVersion !== 1) return null
    const switchedAt = typeof record.switchedAt === 'number' && Number.isFinite(record.switchedAt) && record.switchedAt >= 0
      ? record.switchedAt : 0
    const rawSlots = JsonShape.record(record.slots)
    const slots: Record<string, AntigravitySlotQuota> = {}
    if (rawSlots !== null) {
      for (const [id, item] of Object.entries(rawSlots)) {
        const entry = JsonShape.record(item)
        if (entry === null || typeof entry.capturedAt !== 'number' || !Number.isFinite(entry.capturedAt)) continue
        const session = AntigravityLogins.parseWindow(entry.session)
        const weekly = AntigravityLogins.parseWindow(entry.weekly)
        if (session === null && weekly === null) continue
        slots[id] = { capturedAt: entry.capturedAt, session, weekly }
      }
    }
    return { schemaVersion: 1, switchedAt, slots }
  }

  private static parseWindow(raw: unknown): RateWindow | null {
    const record = JsonShape.record(raw)
    if (record === null) return null
    if (typeof record.durationMinutes !== 'number' || !Number.isFinite(record.durationMinutes) || record.durationMinutes <= 0) return null
    if (typeof record.usedPercent !== 'number' || !Number.isFinite(record.usedPercent)) return null
    const resetsAt = typeof record.resetsAt === 'string' && Number.isFinite(Date.parse(record.resetsAt)) ? record.resetsAt : null
    return { durationMinutes: record.durationMinutes, usedPercent: record.usedPercent, resetsAt }
  }

  private static resolveActiveSlotId(inspected: AntigravityKeyringInspect, currentEmail: string | null): string | null {
    if (!inspected.present) return null
    if (inspected.currentHash !== null) {
      const exact = inspected.slots.find(slot => slot.hash === inspected.currentHash)
      if (exact) return exact.id
    }
    if (currentEmail !== null) {
      const normalized = currentEmail.toLowerCase()
      const matches = inspected.slots.filter(slot => slot.email !== null && slot.email.toLowerCase() === normalized)
      if (matches.length === 1) return matches[0]!.id
    }
    return null
  }

  private static validateLabel(label: string): string {
    const clean = label.trim()
    if (!clean || clean.length > AntigravityLogins.maxLabelLengthConst)
      throw new AccountProblem(`Login name must have 1 to ${AntigravityLogins.maxLabelLengthConst} characters`)
    return clean
  }
}
