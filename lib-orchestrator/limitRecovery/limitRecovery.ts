import type { AccountChoiceRule, DefaultAccountChoice } from '../agentAccounts/defaultAccount'
import { accountWindows } from '../agentAccounts/defaultAccount'
import type { AccountView } from '../agentAccounts/agentAccountsApi.types'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
import type { SessionActivityDetail } from '../sessionManager/sessionManagerApi.types'
import { ErrorText } from '../shared/errorText'
import type {
  LimitAccountRef,
  LimitFact,
  LimitReading,
  LimitRecoveryAction,
  LimitRecoveryReason,
  LimitWindow,
  SessionLimitRecoveryInfo,
} from './limitRecoveryApi.types'

/** The session fields recovery reads; `SessionInfo` has them. */
export interface LimitRecoverySession {
  sessionId: string
  life: 'starting' | 'live' | 'ended' | 'lost'
  activity: 'working' | 'waiting' | 'idle' | 'unknown' | null
  activityDetail?: SessionActivityDetail
  agent?: { agentId: string; accountId?: string }
}

export type LimitRecoveryOutcome = { ok: true } | { ok: false; detail: string }

export interface LimitRecoveryDeps {
  sessions: {
    list(): readonly LimitRecoverySession[]
    switchAccount(sessionId: string, accountId: string): Promise<LimitRecoveryOutcome>
    /** The snapshot must be composed again: a session's recovery moved. */
    changed(): void
  }
  limits: { read(sessionId: string): Promise<LimitReading> }
  accounts: {
    list(): Promise<readonly AccountView[]>
    defaultAccount(agentId: 'claude', rule: AccountChoiceRule, exclude: ReadonlySet<string>): Promise<DefaultAccountChoice> | DefaultAccountChoice
  }
  rates(): readonly RateAccountState[]
  /** Ask the quota sources to read again; the answer arrives through `ratesChanged`. */
  refreshRates(): void
  /** Type the text into the session's composer and submit it. */
  deliver(sessionId: string, text: string): Promise<LimitRecoveryOutcome>
  report(message: string): void
}

type LimitRecoveryAgentId = 'claude' | 'antigravity'

interface Entry {
  sessionId: string
  agentId: LimitRecoveryAgentId
  recordId: string
  limit: LimitFact
  phase: SessionLimitRecoveryInfo['state']
  reason: LimitRecoveryReason
  target: LimitAccountRef | null
  deadlineAt: number
  wakeAt: number | null
  nextAccount: LimitAccountRef | null
  detail: string
  /** Shells of the session run in the background; a switch restarts the session and ends them. */
  background: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Moves a Claude session that stopped on a usage limit to an account with free quota, or waits for
 * the first reset, then types an instruction to continue. Each session gets a countdown the person
 * can cut short or cancel; the switches themselves run one at a time from one queue, each waiting
 * until the previous restart and its instruction finished.
 */
export class LimitRecovery {
  static readonly countdownMillisecondsConst = 60_000
  /** After a reset the server's clock may still be a little behind ours. */
  static readonly resetMarginMillisecondsConst = 60_000
  static readonly pollMillisecondsConst = 10_000
  /** A waiting session re-reads the quota at least this often, for a reset the feed did not announce. */
  static readonly recheckMillisecondsConst = 600_000
  /** How long an account counts as spent when its refusal named no reset. */
  static readonly unknownResetMillisecondsConst = 3_600_000

  private readonly deps: LimitRecoveryDeps
  private readonly entries = new Map<string, Entry>()
  /** The limit record each session was last handled for, so a cancelled or finished one never returns. */
  private readonly handled = new Map<string, string>()
  /** Accounts a session's own refusal proved spent, until their reset; the quota feed can lag behind. */
  private readonly spent = new Map<string, number>()
  private readonly queue: string[] = []
  private work: Promise<void> = Promise.resolve()
  private draining = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private waitTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private stopped = false

  constructor(deps: LimitRecoveryDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.pollTimer !== null || this.stopped) return
    this.pollTimer = setInterval(() => void this.poll(), LimitRecovery.pollMillisecondsConst)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.waitTimer !== null) clearTimeout(this.waitTimer)
    this.waitTimer = null
    for (const entry of this.entries.values()) this.clearTimer(entry)
  }

  infoOf(sessionId: string): SessionLimitRecoveryInfo | null {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return null
    const shells = entry.reason === 'switch' && entry.background ? { stopsBackgroundShells: true as const } : {}
    switch (entry.phase) {
      case 'countdown': return { state: 'countdown', limit: entry.limit, reason: entry.reason, target: entry.target!, deadlineAt: entry.deadlineAt, ...shells }
      case 'queued': return { state: 'queued', limit: entry.limit, reason: entry.reason, target: entry.target!,
        position: this.queue.indexOf(sessionId) + 1, ...shells }
      case 'running': return { state: 'running', limit: entry.limit, reason: entry.reason, target: entry.target!, ...shells }
      case 'waiting': return { state: 'waiting', limit: entry.limit, wakeAt: entry.wakeAt, nextAccount: entry.nextAccount }
      case 'failed': return { state: 'failed', limit: entry.limit, detail: entry.detail }
      default: throw new Error(`Unknown limit recovery phase: ${JSON.stringify(entry.phase)}`)
    }
  }

  /** The person's answer from the popup. */
  act(sessionId: string, action: LimitRecoveryAction): Promise<LimitRecoveryOutcome> {
    return this.serialized(async () => {
      const entry = this.entries.get(sessionId)
      if (entry === undefined) return { ok: false, detail: 'This session has no limit recovery' }
      switch (action) {
        case 'now':
          if (entry.phase !== 'countdown') return { ok: false, detail: 'Only a countdown can start at once' }
          this.enqueue(entry)
          return { ok: true }
        case 'cancel':
          if (entry.phase === 'running') return { ok: false, detail: 'The switch is already running' }
          this.finish(entry)
          return { ok: true }
        case 'dismiss':
          if (entry.phase !== 'failed') return { ok: false, detail: 'Only a failed recovery can be closed' }
          this.finish(entry)
          return { ok: true }
        default: throw new Error(`Unknown limit recovery action: ${JSON.stringify(action)}`)
      }
    })
  }

  /** The quota moved: a waiting session may now have an account to go to. */
  ratesChanged(): void {
    if (![...this.entries.values()].some(entry => entry.phase === 'waiting')) return
    void this.serialized(() => this.reevaluateWaiting())
  }

  /** One detection pass; the interval calls it, a test calls it directly. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try { await this.serialized(() => this.detect()) }
    finally { this.polling = false }
  }

  private async detect(): Promise<void> {
    const now = Date.now()
    for (const [key, resetsAt] of this.spent)
      if (resetsAt + LimitRecovery.resetMarginMillisecondsConst <= now) this.spent.delete(key)
    const sessions = new Map(this.deps.sessions.list()
      .filter((session): session is LimitRecoverySession & { agent: { agentId: LimitRecoveryAgentId; accountId?: string } } =>
        (session.agent?.agentId === 'claude' || session.agent?.agentId === 'antigravity') && session.life === 'live')
      .map(session => [session.sessionId, session]))
    for (const entry of [...this.entries.values()])
      if (entry.phase !== 'running' && !sessions.has(entry.sessionId)) this.finish(entry, false)
    for (const id of [...this.handled.keys()]) if (!sessions.has(id)) this.handled.delete(id)
    let moved = false
    // Every refusal is read before any choice, so an account one session was refused on is never
    // offered to another session in the same pass.
    const found: {
      session: LimitRecoverySession & { agent: { agentId: LimitRecoveryAgentId; accountId?: string } }
      reading: Extract<LimitReading, { kind: 'limit' }>
    }[] = []
    for (const session of sessions.values()) {
      const entry = this.entries.get(session.sessionId)
      if (entry?.phase === 'running') continue
      // A shell can stay in the background after the agent's foreground request hit its limit.
      if (session.activity === 'working' && session.activityDetail !== 'background') {
        if (entry !== undefined) this.finish(entry, false)
        continue
      }
      let reading: LimitReading
      try { reading = await this.deps.limits.read(session.sessionId) }
      catch (error) {
        this.deps.report(`Limit recovery could not read session ${session.sessionId}: ${ErrorText.of(error)}`)
        continue
      }
      if (reading.kind === 'none') {
        this.handled.delete(session.sessionId)
        if (entry !== undefined) this.finish(entry, false)
        continue
      }
      const agentId = session.agent.agentId
      const accountId = session.agent.accountId ?? 'main'
      const spentKey = LimitRecovery.spentKeyOf(agentId, accountId)
      const resetsAt = reading.resetsAt ?? reading.at + LimitRecovery.unknownResetMillisecondsConst
      if (resetsAt > now) this.spent.set(spentKey, Math.max(this.spent.get(spentKey) ?? 0, resetsAt))
      const background = session.activityDetail === 'background'
      if (entry !== undefined) {
        if (entry.recordId === reading.recordId) {
          if (entry.background !== background) {
            entry.background = background
            moved = true
          }
          continue
        }
        this.finish(entry, false)
      }
      if (this.handled.get(session.sessionId) !== reading.recordId) found.push({ session, reading })
    }
    const allAccounts = found.length > 0 || this.entries.size > 0 ? await this.activeAccounts() : []
    for (const entry of this.entries.values())
      if (entry.phase === 'countdown' && entry.reason === 'switch' && !this.free(entry.agentId, entry.target!.accountId, now)) {
        await this.evaluate(entry, allAccounts.filter(account => account.agentId === entry.agentId))
        moved = true
      }
    for (const { session, reading } of found) {
      const agentId = session.agent.agentId
      const accounts = allAccounts.filter(account => account.agentId === agentId)
      const fresh: Entry = {
        sessionId: session.sessionId, agentId, recordId: reading.recordId,
        limit: { account: LimitRecovery.refOf(accounts, session.agent.accountId ?? 'main'), window: reading.window, resetsAt: reading.resetsAt },
        phase: 'waiting', reason: 'switch', target: null, deadlineAt: 0, wakeAt: null, nextAccount: null, detail: '',
        background: session.activityDetail === 'background', timer: null,
      }
      this.entries.set(session.sessionId, fresh)
      await this.evaluate(fresh, accounts)
      moved = true
    }
    this.armWait()
    if (moved) this.deps.sessions.changed()
  }

  /** Decide where a session that is not queued goes now: its own reset, another account, or waiting. */
  private async evaluate(entry: Entry, accounts: readonly AccountView[]): Promise<void> {
    const now = Date.now()
    const own = entry.limit.account.accountId
    if (this.free(entry.agentId, own, now)) {
      this.countdown(entry, 'resume', entry.limit.account)
      return
    }
    if (entry.agentId === 'claude') {
      const target = await this.choose(own, accounts, now)
      if (target !== null) {
        this.countdown(entry, 'switch', LimitRecovery.refOf(accounts, target))
        return
      }
    }
    const next = this.firstReset(entry.agentId, accounts, now, own)
    entry.phase = 'waiting'
    entry.wakeAt = next?.at ?? null
    entry.nextAccount = next === null ? null : LimitRecovery.refOf(accounts, next.accountId)
  }

  private async reevaluateWaiting(): Promise<void> {
    const waiting = [...this.entries.values()].filter(entry => entry.phase === 'waiting')
    if (waiting.length === 0) return
    const allAccounts = await this.activeAccounts()
    for (const entry of waiting)
      if (this.entries.get(entry.sessionId) === entry)
        await this.evaluate(entry, allAccounts.filter(account => account.agentId === entry.agentId))
    this.armWait()
    this.deps.sessions.changed()
  }

  private countdown(entry: Entry, reason: LimitRecoveryReason, target: LimitAccountRef): void {
    this.clearTimer(entry)
    entry.phase = 'countdown'
    entry.reason = reason
    entry.target = target
    entry.deadlineAt = Date.now() + LimitRecovery.countdownMillisecondsConst
    entry.timer = setTimeout(() => void this.serialized(async () => {
      if (this.entries.get(entry.sessionId) === entry && entry.phase === 'countdown') this.enqueue(entry)
    }), LimitRecovery.countdownMillisecondsConst)
  }

  private enqueue(entry: Entry): void {
    this.clearTimer(entry)
    entry.phase = 'queued'
    this.queue.push(entry.sessionId)
    this.deps.sessions.changed()
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const sessionId = this.queue.shift()!
        const entry = this.entries.get(sessionId)
        this.deps.sessions.changed()
        if (entry === undefined || entry.phase !== 'queued') continue
        try { await this.run(entry) }
        catch (error) { this.fail(entry, ErrorText.of(error)) }
      }
    }
    finally { this.draining = false }
  }

  private async run(entry: Entry): Promise<void> {
    entry.phase = 'running'
    this.deps.sessions.changed()
    const session = this.deps.sessions.list().find(candidate => candidate.sessionId === entry.sessionId)
    if (session === undefined || session.life !== 'live') return this.fail(entry, 'The session no longer runs')
    entry.background = session.activityDetail === 'background'
    const reading = await this.deps.limits.read(entry.sessionId)
    // The person typed something in the meantime: the session left its limit on its own.
    if (reading.kind !== 'limit' || reading.recordId !== entry.recordId) return this.finish(entry, false)
    if (entry.reason === 'switch') {
      const accounts = (await this.activeAccounts()).filter(account => account.agentId === entry.agentId)
      const target = entry.agentId === 'claude' ? await this.choose(entry.limit.account.accountId, accounts, Date.now()) : null
      if (target === null) {
        await this.serialized(async () => { await this.evaluate(entry, accounts); this.armWait() })
        this.deps.sessions.changed()
        return
      }
      entry.target = LimitRecovery.refOf(accounts, target)
      this.deps.sessions.changed()
      const switched = await this.deps.sessions.switchAccount(entry.sessionId, target)
      if (!switched.ok) return this.fail(entry, `The switch to ${entry.target.label} failed: ${switched.detail}`)
    }
    const delivered = await this.deps.deliver(entry.sessionId,
      LimitRecovery.promptOf(entry.limit, entry.reason, entry.target!, entry.reason === 'switch' && entry.background))
    if (!delivered.ok) return this.fail(entry, `The instruction to continue was not sent: ${delivered.detail}`)
    this.finish(entry)
  }

  /**
   * The text typed into the session once it can go on. A resumed agent no longer owns the shells the
   * restart ended and would wait for their notifications forever unless it is told.
   */
  static promptOf(limit: LimitFact, reason: LimitRecoveryReason, target: LimitAccountRef, stoppedShells = false): string {
    const window = LimitRecovery.windowWordOf(limit.window)
    switch (reason) {
      case 'switch': return `Jamat: account ${limit.account.label} reached its ${window} limit, so this session now continues on account ${
        target.label}. ${stoppedShells ? 'The restart stopped your background shells; start again what they were running, then continue'
        : 'Continue'} the work where you stopped.`
      case 'resume': return `Jamat: the ${window} limit of account ${limit.account.label} has reset. Continue the work where you stopped.`
      default: throw new Error(`Unknown limit recovery reason: ${JSON.stringify(reason)}`)
    }
  }

  private static windowWordOf(window: LimitWindow): string {
    switch (window) {
      case 'session': return '5-hour usage'
      case 'weekly': return 'weekly usage'
      case 'other': return 'usage'
      default: throw new Error(`Unknown limit window: ${JSON.stringify(window)}`)
    }
  }

  private fail(entry: Entry, detail: string): void {
    this.clearTimer(entry)
    entry.phase = 'failed'
    entry.detail = detail
    this.handled.set(entry.sessionId, entry.recordId)
    this.deps.sessions.changed()
  }

  /** Remove the entry; `handled` keeps a cancelled or finished limit record from starting again. */
  private finish(entry: Entry, handled = true): void {
    this.clearTimer(entry)
    if (this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId)
    const queued = this.queue.indexOf(entry.sessionId)
    if (queued >= 0) this.queue.splice(queued, 1)
    if (handled) this.handled.set(entry.sessionId, entry.recordId)
    this.deps.sessions.changed()
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }

  /** One timer for every waiting session: the first reset, or the periodic quota re-read. */
  private armWait(): void {
    if (this.waitTimer !== null) clearTimeout(this.waitTimer)
    this.waitTimer = null
    const waiting = [...this.entries.values()].filter(entry => entry.phase === 'waiting')
    if (waiting.length === 0 || this.stopped) return
    const now = Date.now()
    const first = Math.min(...waiting.map(entry => entry.wakeAt ?? Infinity), now + LimitRecovery.recheckMillisecondsConst)
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null
      // A reset is due: read the quota now rather than at the next poll. A plain recheck reads what is there.
      if ([...this.entries.values()].some(entry => entry.phase === 'waiting' && entry.wakeAt !== null && entry.wakeAt <= Date.now()))
        this.deps.refreshRates()
      void this.serialized(() => this.reevaluateWaiting())
    }, Math.max(0, first - now))
  }

  /** The best account other than `own` that is not spent, by the shared paced rule. */
  private async choose(own: string, accounts: readonly AccountView[], now: number): Promise<string | null> {
    const exclude = new Set([own, ...accounts.filter(account => !this.free('claude', account.accountId, now)).map(account => account.accountId)])
    if (accounts.every(account => exclude.has(account.accountId))) return null
    const choice = await this.deps.accounts.defaultAccount('claude', 'paced', exclude)
    return exclude.has(choice.accountId) || !accounts.some(account => account.accountId === choice.accountId) ? null : choice.accountId
  }

  /** Free once every limit known for the account has passed its reset by the margin. */
  private free(agentId: LimitRecoveryAgentId, accountId: string, now: number): boolean {
    const until = this.blockedUntil(agentId, accountId, now)
    return until === null || now >= until + LimitRecovery.resetMarginMillisecondsConst
  }

  /** The latest reset among the account's spent windows; Infinity when a spent window names no reset. */
  private blockedUntil(agentId: LimitRecoveryAgentId, accountId: string, now: number): number | null {
    let until: number | null = this.spent.get(LimitRecovery.spentKeyOf(agentId, accountId)) ?? null
    const rate = this.deps.rates().find(candidate => candidate.key.agentId === agentId && candidate.key.accountId === accountId)
    for (const window of accountWindows(rate)) {
      if (window.model !== undefined || window.usedPercent < 100) continue
      if (window.durationMinutes !== 300 && window.durationMinutes !== 10_080) continue
      const reset = window.resetsAt === null ? Infinity : Date.parse(window.resetsAt)
      if (Number.isNaN(reset) || reset <= now) continue
      until = Math.max(until ?? 0, reset)
    }
    return until
  }

  private firstReset(
    agentId: LimitRecoveryAgentId,
    accounts: readonly AccountView[],
    now: number,
    fallbackAccountId: string,
  ): { accountId: string; at: number } | null {
    const ids = accounts.length > 0 ? accounts.map(account => account.accountId) : [fallbackAccountId]
    let first: { accountId: string; at: number } | null = null
    for (const accountId of ids) {
      const until = this.blockedUntil(agentId, accountId, now)
      if (until === null || !Number.isFinite(until)) continue
      const at = until + LimitRecovery.resetMarginMillisecondsConst
      if (first === null || at < first.at) first = { accountId, at }
    }
    return first
  }

  private async activeAccounts(): Promise<readonly AccountView[]> {
    return (await this.deps.accounts.list())
      .filter(account => (account.agentId === 'claude' || account.agentId === 'antigravity') && account.state === 'active')
  }

  private static spentKeyOf(agentId: LimitRecoveryAgentId, accountId: string): string {
    return `${agentId}/${accountId}`
  }

  private static refOf(accounts: readonly AccountView[], accountId: string): LimitAccountRef {
    const label = accounts.find(account => account.accountId === accountId)?.label
    return { accountId, label: label ?? (accountId === 'main' ? 'Main' : accountId) }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.work.then(work)
    this.work = run.then(() => undefined, (error: unknown) => this.deps.report(`Limit recovery failed: ${ErrorText.of(error)}`))
    return run
  }
}
