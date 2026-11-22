import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chooseDefault } from '../agentAccounts/defaultAccount'
import type { AccountView } from '../agentAccounts/agentAccountsApi.types'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
import { LimitRecovery, type LimitRecoveryOutcome, type LimitRecoverySession } from './limitRecovery'
import type { LimitReading } from './limitRecoveryApi.types'

describe('lib-orchestrator/limitRecovery/limitRecovery', () => {
  const start = Date.parse('2026-11-21T10:00:00.000Z')
  const minute = 60_000, hour = 3_600_000

  class World {
    sessions: LimitRecoverySession[] = []
    readings = new Map<string, LimitReading>()
    accounts: AccountView[] = [World.account('main', 'Main'), World.account('work', 'Work')]
    rates: RateAccountState[] = []
    switches: [string, string][] = []
    delivered: [string, string][] = []
    refreshes = 0
    reports: string[] = []
    switchResult: () => Promise<LimitRecoveryOutcome> = async () => ({ ok: true })
    deliverResult: () => Promise<LimitRecoveryOutcome> = async () => ({ ok: true })
    readonly recovery = new LimitRecovery({
      sessions: {
        list: () => this.sessions,
        switchAccount: async (sessionId, accountId) => {
          this.switches.push([sessionId, accountId])
          const result = await this.switchResult()
          if (result.ok) this.sessions.find(session => session.sessionId === sessionId)!.agent!.accountId = accountId
          return result
        },
        changed: () => {},
      },
      limits: { read: async (sessionId) => this.readings.get(sessionId) ?? { kind: 'none' } },
      accounts: {
        list: async () => this.accounts,
        defaultAccount: (agentId, rule, exclude) => chooseDefault(agentId,
          this.accounts.filter(account => !exclude.has(account.accountId)), this.rates, [], Date.now(), rule),
      },
      rates: () => this.rates,
      refreshRates: () => { this.refreshes += 1 },
      deliver: async (sessionId, text) => {
        this.delivered.push([sessionId, text])
        return this.deliverResult()
      },
      report: (message) => { this.reports.push(message) },
    })

    static account(accountId: string, label: string): AccountView {
      return { agentId: 'claude', accountId, label, isMain: accountId === 'main', state: 'active' } as AccountView
    }

    session(sessionId: string, accountId = 'main'): void {
      this.sessions.push({ sessionId, life: 'live', activity: 'idle', agent: { agentId: 'claude', accountId } })
    }

    limit(sessionId: string, recordId = `limit-${sessionId}`, resetsIn = hour, window: 'session' | 'weekly' = 'session'): void {
      this.readings.set(sessionId, { kind: 'limit', recordId, at: Date.now(), window, resetsAt: Date.now() + resetsIn })
    }

    spend(accountId: string, used: number, resetsIn: number): void {
      this.rates = this.rates.filter(rate => rate.key.accountId !== accountId)
      this.rates.push({ key: { agentId: 'claude', accountId }, label: accountId, estimated: null, source: 'poll',
        state: { kind: 'ok', fetchedAt: Date.now(), windows: [{ durationMinutes: 10_080, usedPercent: used,
          resetsAt: new Date(Date.now() + resetsIn).toISOString() }] } })
    }

    info(sessionId: string) {
      return this.recovery.infoOf(sessionId)
    }
  }

  let world: World
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
    world = new World()
  })
  afterEach(() => {
    world.recovery.stop()
    vi.useRealTimers()
  })

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
  }

  it('counts down to another free account, switches, then types the instruction to continue', async () => {
    world.session('s1')
    world.limit('s1')
    await world.recovery.poll()
    expect(world.info('s1')).toEqual({ state: 'countdown', reason: 'switch', target: { accountId: 'work', label: 'Work' },
      deadlineAt: start + minute, limit: { account: { accountId: 'main', label: 'Main' }, window: 'session', resetsAt: start + hour } })
    await vi.advanceTimersByTimeAsync(minute - 1)
    expect(world.switches).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(world.switches).toEqual([['s1', 'work']])
    expect(world.delivered).toEqual([['s1', 'Jamat: account Main reached its 5-hour usage limit, so this session now continues on account Work. Continue the work where you stopped.']])
    expect(world.info('s1')).toBeNull()
    // The resumed conversation still ends with the refusal until the instruction lands; it never starts again.
    world.sessions[0].agent!.accountId = 'main'
    await world.recovery.poll()
    expect(world.info('s1')).toBeNull()
  })

  it('starts at once on Switch now and stops for good on Cancel', async () => {
    world.session('s1')
    world.session('s2')
    world.limit('s1')
    world.limit('s2')
    await world.recovery.poll()
    expect(await world.recovery.act('s1', 'now')).toEqual({ ok: true })
    await settle()
    expect(world.switches).toEqual([['s1', 'work']])
    expect(await world.recovery.act('s2', 'cancel')).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(2 * minute)
    await world.recovery.poll()
    expect(world.switches).toEqual([['s1', 'work']])
    expect(world.info('s2')).toBeNull()
  })

  it('waits while every account is spent, then resumes on its own account after its reset', async () => {
    world.session('s1')
    world.limit('s1', 'limit-s1', hour)
    world.spend('work', 100, 3 * hour)
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'waiting', wakeAt: start + hour + minute, nextAccount: { accountId: 'main' } })
    await vi.advanceTimersByTimeAsync(hour + minute)
    expect(world.refreshes).toBe(1)
    expect(world.info('s1')).toMatchObject({ state: 'countdown', reason: 'resume', target: { accountId: 'main' } })
    await vi.advanceTimersByTimeAsync(minute)
    expect(world.switches).toEqual([])
    expect(world.delivered).toEqual([['s1', 'Jamat: the 5-hour usage limit of account Main has reset. Continue the work where you stopped.']])
  })

  it('switches from waiting when the quota shows another account free', async () => {
    world.session('s1')
    world.limit('s1', 'limit-s1', 2 * hour)
    world.spend('work', 100, 3 * hour)
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'waiting' })
    world.spend('work', 10, 6 * 24 * hour)
    world.recovery.ratesChanged()
    await settle()
    expect(world.info('s1')).toMatchObject({ state: 'countdown', reason: 'switch', target: { accountId: 'work' } })
  })

  it('keeps a refused session with a background shell waiting until its account resets', async () => {
    world.session('s1')
    Object.assign(world.sessions[0], { activity: 'working', activityDetail: 'background' })
    world.limit('s1')
    world.spend('work', 100, 3 * hour)
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'waiting', wakeAt: start + hour + minute })
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'waiting' })
    await vi.advanceTimersByTimeAsync(hour + minute)
    expect(world.info('s1')).toMatchObject({ state: 'countdown', reason: 'resume' })
    await world.recovery.poll()
    await vi.advanceTimersByTimeAsync(minute)
    expect(world.switches).toEqual([])
    expect(world.delivered).toHaveLength(1)
    expect(world.info('s1')).toBeNull()
  })

  it('switches a refused session with background work after the countdown', async () => {
    world.session('s1')
    Object.assign(world.sessions[0], { activity: 'working', activityDetail: 'background' })
    world.limit('s1')
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'countdown', reason: 'switch', stopsBackgroundShells: true })
    await world.recovery.poll()
    await vi.advanceTimersByTimeAsync(minute)
    expect(world.switches).toEqual([['s1', 'work']])
    expect(world.delivered).toEqual([['s1', 'Jamat: account Main reached its 5-hour usage limit, so this session now continues on account Work. '
      + 'The restart stopped your background shells; start again what they were running, then continue the work where you stopped.']])
    expect(world.info('s1')).toBeNull()
  })

  it('drops the background-shell warning once the shells ended', async () => {
    world.session('s1')
    Object.assign(world.sessions[0], { activity: 'working', activityDetail: 'background' })
    world.limit('s1')
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ stopsBackgroundShells: true })
    Object.assign(world.sessions[0], { activity: 'idle', activityDetail: undefined })
    await world.recovery.poll()
    expect(world.info('s1')).not.toHaveProperty('stopsBackgroundShells')
    await world.recovery.act('s1', 'now')
    await settle()
    expect(world.delivered[0]?.[1]).toContain('Continue the work where you stopped.')
  })

  it('never warns about background shells on a resume, which restarts nothing', async () => {
    world.session('s1')
    Object.assign(world.sessions[0], { activity: 'working', activityDetail: 'background' })
    world.limit('s1', 'limit-s1', -2 * minute)
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'countdown', reason: 'resume' })
    expect(world.info('s1')).not.toHaveProperty('stopsBackgroundShells')
  })

  it('requires a current refusal for background work and still skips foreground work', async () => {
    world.session('background')
    Object.assign(world.sessions[0], { activity: 'working', activityDetail: 'background' })
    world.session('foreground')
    world.sessions[1].activity = 'working'
    world.limit('foreground')
    await world.recovery.poll()
    expect(world.info('background')).toBeNull()
    expect(world.info('foreground')).toBeNull()
    world.limit('background')
    await world.recovery.poll()
    expect(world.info('background')).toMatchObject({ state: 'countdown' })
    world.readings.set('background', { kind: 'none' })
    await world.recovery.poll()
    expect(world.info('background')).toBeNull()
    await vi.advanceTimersByTimeAsync(minute)
    expect(world.switches).toEqual([])
    expect(world.delivered).toEqual([])
  })

  it('treats an account another session was refused on as spent before the quota feed shows it', async () => {
    world.session('s1', 'main')
    world.session('s2', 'work')
    world.limit('s1')
    world.limit('s2')
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'waiting' })
    expect(world.info('s2')).toMatchObject({ state: 'waiting' })
  })

  it('runs the switches one at a time, in the order the countdowns ended', async () => {
    world.accounts.push(World.account('spare', 'Spare'))
    world.session('s1')
    world.session('s2')
    world.limit('s1')
    world.limit('s2')
    let release: () => void = () => {}
    world.switchResult = () => new Promise(resolve => { release = () => resolve({ ok: true }) })
    await world.recovery.poll()
    await world.recovery.act('s1', 'now')
    await settle()
    await world.recovery.act('s2', 'now')
    await settle()
    expect(world.switches).toHaveLength(1)
    expect(world.info('s1')).toMatchObject({ state: 'running' })
    expect(world.info('s2')).toMatchObject({ state: 'queued', position: 1 })
    world.switchResult = async () => ({ ok: true })
    release()
    await settle()
    expect(world.switches.map(([sessionId]) => sessionId)).toEqual(['s1', 's2'])
    expect(world.delivered.map(([sessionId]) => sessionId)).toEqual(['s1', 's2'])
  })

  it('shows a failed instruction until it is closed, and never starts that limit again', async () => {
    world.session('s1')
    world.limit('s1')
    world.deliverResult = async () => ({ ok: false, detail: 'the composer holds a draft' })
    await world.recovery.poll()
    await world.recovery.act('s1', 'now')
    await settle()
    expect(world.info('s1')).toEqual({ state: 'failed', limit: expect.anything(),
      detail: 'The instruction to continue was not sent: the composer holds a draft' })
    expect(await world.recovery.act('s1', 'dismiss')).toEqual({ ok: true })
    await world.recovery.poll()
    expect(world.info('s1')).toBeNull()
  })

  it('drops the recovery when the person continued on their own before it ran', async () => {
    world.session('s1')
    world.limit('s1')
    await world.recovery.poll()
    world.readings.set('s1', { kind: 'none' })
    await vi.advanceTimersByTimeAsync(minute)
    expect(world.switches).toEqual([])
    expect(world.info('s1')).toBeNull()
  })

  it('ends the recovery when the session works again or no longer runs, and starts on a new refusal', async () => {
    world.session('s1')
    world.limit('s1')
    await world.recovery.poll()
    world.sessions[0].activity = 'working'
    await world.recovery.poll()
    expect(world.info('s1')).toBeNull()
    world.sessions[0].activity = 'idle'
    world.limit('s1', 'limit-s1-again')
    await world.recovery.poll()
    expect(world.info('s1')).toMatchObject({ state: 'countdown' })
    world.sessions[0].life = 'ended'
    await world.recovery.poll()
    expect(world.info('s1')).toBeNull()
  })

  it('ignores Codex sessions and refuses actions it cannot take', async () => {
    world.sessions.push({ sessionId: 'c1', life: 'live', activity: 'idle', agent: { agentId: 'codex' } })
    world.limit('c1')
    await world.recovery.poll()
    expect(world.info('c1')).toBeNull()
    expect(await world.recovery.act('c1', 'now')).toEqual({ ok: false, detail: 'This session has no limit recovery' })
    world.session('s1')
    world.limit('s1')
    await world.recovery.poll()
    expect(await world.recovery.act('s1', 'dismiss')).toEqual({ ok: false, detail: 'Only a failed recovery can be closed' })
  })

  it('waits for reset and resumes an Antigravity session without attempting an account switch', async () => {
    world.accounts.push({
      agentId: 'antigravity',
      accountId: 'main',
      label: 'Main',
      isMain: true,
      state: 'active',
      identity: null,
      profileProblem: null,
    })
    world.sessions.push({ sessionId: 'agy-1', life: 'live', activity: 'idle', agent: { agentId: 'antigravity', accountId: 'main' } })
    world.limit('agy-1', 'agy-limit-1', 5 * minute)
    await world.recovery.poll()
    expect(world.info('agy-1')).toMatchObject({
      state: 'waiting',
      wakeAt: Date.now() + 6 * minute,
      nextAccount: { accountId: 'main', label: 'Main' },
    })
    expect(world.switches).toEqual([])
    await vi.advanceTimersByTimeAsync(6 * minute)
    expect(world.info('agy-1')).toMatchObject({
      state: 'countdown',
      reason: 'resume',
      target: { accountId: 'main', label: 'Main' },
    })
    await vi.advanceTimersByTimeAsync(minute)
    expect(world.switches).toEqual([])
    expect(world.delivered).toEqual([['agy-1', 'Jamat: the 5-hour usage limit of account Main has reset. Continue the work where you stopped.']])
    expect(world.info('agy-1')).toBeNull()
  })
})
