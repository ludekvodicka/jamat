import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
import { AntigravityLogins, type AntigravityKeyringPort } from './antigravityLogins'
import type { AntigravityKeyringMeta } from './antigravity/windowsAntigravityKeyring'

class MemoryKeyring implements AntigravityKeyringPort {
  available = true
  unavailableReason: string | null = null
  activeBlob: string | null = null
  readonly slots = new Map<string, { blob: string; meta: AntigravityKeyringMeta }>()

  async inspect() {
    return {
      present: this.activeBlob !== null,
      currentHash: this.activeBlob === null ? null : `hash:${this.activeBlob}`,
      slots: [...this.slots.entries()].map(([id, entry]) => ({
        id,
        hash: `hash:${entry.blob}`,
        ...entry.meta,
      })),
    }
  }

  async store(slotId: string, meta: AntigravityKeyringMeta) {
    if (this.activeBlob === null) throw new Error('missing active blob')
    this.slots.set(slotId, { blob: this.activeBlob, meta })
  }

  async activate(slotId: string) {
    const slot = this.slots.get(slotId)
    if (!slot) throw new Error('missing slot')
    this.activeBlob = slot.blob
  }

  async clear() {
    this.activeBlob = null
  }

  async remove(slotId: string) {
    this.slots.delete(slotId)
  }
}

describe('lib-orchestrator/agentAccounts/antigravityLogins', () => {
  const roots: string[] = []
  const instances: AntigravityLogins[] = []
  afterEach(() => {
    for (const item of instances.splice(0)) item.stop()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    vi.useRealTimers()
  })

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'jamat-agy-logins-'))
    roots.push(root)
    const accountFile = join(root, 'antigravity-account.json')
    const quotaFile = join(root, 'antigravity-login-quotas.json')
    const keyring = new MemoryKeyring()
    const events: string[] = []
    const originalActivate = keyring.activate.bind(keyring)
    keyring.activate = async slotId => {
      events.push(`activate:${slotId}`)
      return originalActivate(slotId)
    }
    const openLogin = vi.fn(async () => ({ sessionId: 'login-session-1' }))
    const stopRunningSessions = vi.fn(async () => {
      events.push('stop')
      return {
        stopped: [
          { sessionId: 'session-1', title: 'One' },
          { sessionId: 'session-2', title: 'Two' },
        ],
        failed: [] as string[],
      }
    })
    const reopenSessions = vi.fn(async (sessions: readonly { sessionId: string; title: string }[]) => {
      events.push(`reopen:${sessions.map(item => item.sessionId).join(',')}`)
      return { reopened: sessions.length, failed: [] as string[] }
    })
    const resetRates = vi.fn((switchedAt: number) => { events.push(`resetRates:${switchedAt}`) })
    const onChanged = vi.fn()
    let running = 0
    let reopenable = 0
    let currentNow = Date.parse('2026-11-22T15:00:00Z')
    let rates: readonly RateAccountState[] = []
    let loginEnded = false
    const logins = new AntigravityLogins({
      keyring,
      accountFile,
      quotaFile,
      runningSessionCount: () => running,
      reopenableSessionCount: () => reopenable,
      stopRunningSessions,
      reopenSessions,
      rates: () => rates,
      resetRates,
      openLogin,
      loginResult: () => loginEnded ? { ended: true, exitCode: 0 } : { ended: false },
      onChanged,
      now: () => currentNow,
    })
    instances.push(logins)
    return {
      root, accountFile, quotaFile, keyring, events, openLogin, stopRunningSessions, reopenSessions, resetRates, onChanged, logins,
      setRunning: (count: number) => { running = count },
      setReopenable: (count: number) => { reopenable = count },
      setNow: (ms: number) => { currentNow = ms },
      setRates: (next: readonly RateAccountState[]) => { rates = next },
      setLoginEnded: (ended: boolean) => { loginEnded = ended },
    }
  }

  it('stores, clears, launches a new login, stores a second account, and switches back and forth', async () => {
    const { accountFile, quotaFile, keyring, events, openLogin, stopRunningSessions, reopenSessions, resetRates, onChanged, logins, setRunning, setReopenable } = setup()
    keyring.activeBlob = 'token-alice'
    writeFileSync(accountFile, JSON.stringify({ schemaVersion: 1, email: 'alice@example.com', planTier: 'Pro' }))

    const alice = await logins.store('Alice')
    expect(alice.slotId).toMatch(/^alice-[0-9a-f]{8}$/)
    await expect(logins.store('alice')).rejects.toThrow('already exists')

    const afterStore = await logins.list()
    expect(afterStore).toMatchObject({
      available: true,
      currentPresent: true,
      activeSlotId: alice.slotId,
      currentEmail: 'alice@example.com',
      currentPlanTier: 'Pro',
      logins: [{ id: alice.slotId, label: 'Alice', email: 'alice@example.com', planTier: 'Pro', active: true, quota: null }],
    })

    await expect(logins.login()).rejects.toThrow('Clear the current login')
    await logins.clear()
    expect(keyring.activeBlob).toBeNull()
    expect(existsSync(accountFile)).toBe(false)
    expect(resetRates).toHaveBeenCalledTimes(1)

    expect(await logins.login()).toEqual({ sessionId: 'login-session-1' })
    expect(openLogin).toHaveBeenCalledTimes(1)

    keyring.activeBlob = 'token-bob'
    writeFileSync(accountFile, JSON.stringify({ schemaVersion: 1, email: 'bob@example.com', planTier: 'Ultra' }))
    const bob = await logins.store('Bob')

    setRunning(2)
    setReopenable(2)
    events.length = 0
    expect(await logins.switchTo(alice.slotId, { reopenRunning: true })).toEqual({ reopened: 2, failed: [] })
    expect(stopRunningSessions).toHaveBeenCalledTimes(1)
    expect(reopenSessions).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      'stop',
      `activate:${alice.slotId}`,
      `resetRates:${Date.parse('2026-11-22T15:00:00Z')}`,
      'reopen:session-1,session-2',
    ])
    expect(keyring.activeBlob).toBe('token-alice')
    expect(JSON.parse(readFileSync(accountFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      email: 'alice@example.com',
      planTier: 'Pro',
    })
    expect(await logins.list()).toMatchObject({
      activeSlotId: alice.slotId,
      runningSessionCount: 2,
      reopenableSessionCount: 2,
      logins: [
        { id: alice.slotId, label: 'Alice', active: true },
        { id: bob.slotId, label: 'Bob', active: false },
      ],
    })
    expect(onChanged).toHaveBeenCalled()

    // A fresh instance reads the persisted switchedAt synchronously before any async list() call.
    const reloaded = new AntigravityLogins({
      keyring,
      accountFile,
      quotaFile,
      runningSessionCount: () => 0,
      onChanged: () => {},
    })
    instances.push(reloaded)
    expect(reloaded.switchedAt()).toBe(Date.parse('2026-11-22T15:00:00Z'))
  })

  it('remembers 5h and weekly quota per slot, guards against stale post-switch readings, and advances expired resets', async () => {
    const { accountFile, keyring, logins, setNow, setRates } = setup()
    const t0 = Date.parse('2026-11-22T15:00:00Z')
    setNow(t0)
    keyring.activeBlob = 'token-alice'
    writeFileSync(accountFile, JSON.stringify({ schemaVersion: 1, email: 'alice@example.com', planTier: 'Pro' }))
    setRates([{
      key: { agentId: 'antigravity', accountId: 'main' },
      label: 'Main',
      source: 'statusline',
      estimated: null,
      state: {
        kind: 'ok',
        fetchedAt: t0,
        windows: [
          { durationMinutes: 300, usedPercent: 95, resetsAt: '2026-11-22T18:00:00.000Z' },
          { durationMinutes: 10080, usedPercent: 40, resetsAt: '2026-11-26T12:00:00.000Z' },
        ],
      },
    }])

    const alice = await logins.store('Alice')
    await logins.clear()
    keyring.activeBlob = 'token-bob'
    writeFileSync(accountFile, JSON.stringify({ schemaVersion: 1, email: 'bob@example.com', planTier: 'Ultra' }))
    setNow(t0 + 60_000)
    const bob = await logins.store('Bob')

    // Stale reading from before clear/switch must not be attributed to Bob.
    const afterSwitch = await logins.list()
    expect(afterSwitch.logins.find(slot => slot.id === alice.slotId)?.quota).toEqual({
      capturedAt: t0,
      session: { durationMinutes: 300, usedPercent: 95, resetsAt: '2026-11-22T18:00:00.000Z' },
      weekly: { durationMinutes: 10080, usedPercent: 40, resetsAt: '2026-11-26T12:00:00.000Z' },
    })
    expect(afterSwitch.logins.find(slot => slot.id === bob.slotId)?.quota).toBeNull()

    // A fresh reading after switch updates Bob via ratesChanged, and advancing past Alice's 5h reset projects Alice's 5h to 0%.
    const tLater = Date.parse('2026-11-22T19:00:00Z')
    setNow(tLater)
    setRates([{
      key: { agentId: 'antigravity', accountId: 'main' },
      label: 'Main',
      source: 'statusline',
      estimated: null,
      state: {
        kind: 'ok',
        fetchedAt: tLater,
        windows: [
          { durationMinutes: 300, usedPercent: 12, resetsAt: '2026-11-22T23:00:00.000Z' },
          { durationMinutes: 10080, usedPercent: 8, resetsAt: '2026-11-29T10:00:00.000Z' },
        ],
      },
    }])
    logins.ratesChanged()
    const projected = await logins.list()
    expect(projected.logins.find(slot => slot.id === alice.slotId)?.quota).toEqual({
      capturedAt: t0,
      session: { durationMinutes: 300, usedPercent: 0, resetsAt: '2026-11-22T23:00:00.000Z' },
      weekly: { durationMinutes: 10080, usedPercent: 40, resetsAt: '2026-11-26T12:00:00.000Z' },
    })
    expect(projected.logins.find(slot => slot.id === bob.slotId)?.quota).toEqual({
      capturedAt: tLater,
      session: { durationMinutes: 300, usedPercent: 12, resetsAt: '2026-11-22T23:00:00.000Z' },
      weekly: { durationMinutes: 10080, usedPercent: 8, resetsAt: '2026-11-29T10:00:00.000Z' },
    })
  })

  it('auto-refreshes when the login credential appears or the Login: Antigravity terminal exits', async () => {
    vi.useFakeTimers()
    const { keyring, onChanged, logins, setLoginEnded } = setup()
    await logins.login()
    onChanged.mockClear()
    expect((await logins.list()).loginInProgress).toBe(true)

    keyring.activeBlob = 'token-fresh'
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onChanged).toHaveBeenCalledTimes(1)

    setLoginEnded(true)
    logins.sessionsChanged()
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect((await logins.list()).loginInProgress).toBe(false)
  })

  it('matches active slot by unique observed email after an access-token refresh and updates stored blobs', async () => {
    const { accountFile, keyring, logins } = setup()
    keyring.activeBlob = 'token-v1'
    writeFileSync(accountFile, JSON.stringify({ schemaVersion: 1, email: 'alice@example.com', planTier: 'Pro' }))
    const alice = await logins.store('Alice')

    keyring.activeBlob = 'token-v2-refreshed'
    const listed = await logins.list()
    expect(listed.activeSlotId).toBe(alice.slotId)

    await logins.update(alice.slotId)
    expect(keyring.slots.get(alice.slotId)?.blob).toBe('token-v2-refreshed')
  })

  it('removes a saved login without touching the active credential and clears stale email when switching to an email-less slot', async () => {
    const { accountFile, keyring, logins } = setup()
    keyring.activeBlob = 'token-no-email'
    const anon = await logins.store('Backup')

    keyring.activeBlob = 'token-other'
    writeFileSync(accountFile, JSON.stringify({ schemaVersion: 1, email: 'other@example.com' }))
    await logins.switchTo(anon.slotId)
    expect(existsSync(accountFile)).toBe(false)

    await logins.remove(anon.slotId)
    expect(keyring.activeBlob).toBe('token-no-email')
    expect((await logins.list()).logins).toEqual([])
  })
})
