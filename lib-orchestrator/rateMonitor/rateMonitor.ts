import type { RuntimeChannel } from '../shared/configIdentity.types'
import { ErrorText } from '../shared/errorText'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import {
  type RateMonitorCacheContent,
  type RateMonitorCacheEntry,
  RateMonitorCacheStore,
} from './cache/rateMonitorCacheStore'
import { RateMonitorSources } from './rateMonitorSources'
import type {
  RateAgentId,
  RateExtra,
  RateMonitorDebugStatus,
  RateMonitorSnapshot,
  RateProviderDebug,
  RateProviderState,
  RateWindow,
} from './rateMonitorApi.types'

/** What a source may set off outside a read of its own. Today the Codex push notification, nothing else. */
export interface RateSourceHooks {
  nudge(agentId: RateAgentId): void
}

export type RateSourceReading =
  | {
    kind: 'ok'
    windows: readonly RateWindow[]
    extras: readonly RateExtra[]
    raw: unknown
    oauthExpiresAt: number | null
  }
  | { kind: 'unconfigured'; reason: string; oauthExpiresAt: number | null }
  | { kind: 'failed'; reason: string; oauthExpiresAt: number | null }

/**
 * One provider's side of this subsystem, and deliberately narrow: the two providers agree on nothing
 * except the answer. A source NEVER throws - every ending is one of the readings above - because the
 * cadence, the last good windows and the cache all live in the facade and must not be lost to a
 * rejection thrown out of a timer.
 */
export interface RateLimitSource {
  readonly agentId: RateAgentId
  read(): Promise<RateSourceReading>
  stop(): void
}

export interface RateMonitorDeps {
  configIdentity: string
  channel: RuntimeChannel
  /** One call per move of the content the snapshot shows; coalescing them is the renderer's job. */
  onChanged: () => void
  onError: (message: string) => void
  /**
   * The seam the tests hand fakes in through; left out, the monitor drives the two real providers.
   * `hooks` travels with them so a fake can do what the Codex notification does, which is the one
   * thing a source sets off that no read asked for.
   */
  sources?: (hooks: RateSourceHooks) => readonly RateLimitSource[]
  cacheFile?: string
  now?: () => number
}

/**
 * How much of each provider's rate limit is spent, seen from outside it: one snapshot with a revision,
 * one unreduced debug view, and one manual refresh.
 *
 * Three things are genuinely this class's own, and every one of them exists because a source must not
 * be the place that holds it:
 *
 * 1. **One cadence.** Ten minutes while anything is visible, nothing at all while nothing is. Coming
 *    back into view reads only what has gone stale meanwhile, so a window toggled twice in a minute
 *    costs no requests. Claude carries a floor on top of that, measured from the last ATTEMPT.
 * 2. **The last good windows.** A failed read never destroys them: it becomes `stale` over the same
 *    windows, and what a surface then draws is the last thing that provider actually said.
 * 3. **One snapshot, one revision.** The revision is the identity of the content handed out with it,
 *    so a poll that moved nothing emits nothing and wakes no window.
 */
export class RateMonitor {
  private static readonly pollMillisecondsConst = 600_000
  /**
   * The Claude usage endpoint is undocumented and refuses a client that asks too often for a long
   * time afterwards. Measured from the ATTEMPT and not from the success, so a run of failures cannot
   * turn into a run of requests, and it holds for a manual refresh too: a widget nobody can stop
   * clicking is exactly the caller this protects the endpoint from.
   */
  private static readonly claudeFloorMillisecondsConst = 180_000
  /**
   * A ceiling on the one read nothing else bounds. A nudge is a provider saying its numbers moved,
   * and the read that follows could be what makes it say so again: `account/rateLimits/read` and
   * `account/rateLimits/updated` would then feed each other for as long as a window is open, and
   * single-flight merges only the CONCURRENT ones. Small on purpose - it bounds a cycle rather than
   * setting a cadence, and the cadence and the manual refresh are untouched by it.
   */
  private static readonly nudgeFloorMillisecondsConst = 5_000

  private readonly sources: ReadonlyMap<RateAgentId, RateLimitSource>
  private readonly cache: RateMonitorCacheStore
  private readonly cacheFile: string
  private readonly now: () => number
  private readonly providers: Record<RateAgentId, RateProviderState> = {
    claude: { kind: 'never-read' },
    codex: { kind: 'never-read' },
  }
  private readonly lastGood = new Map<RateAgentId, RateMonitorCacheEntry>()
  private readonly attemptAt: Record<RateAgentId, number | null> = { claude: null, codex: null }
  private readonly successAt: Record<RateAgentId, number | null> = { claude: null, codex: null }
  private readonly lastReason: Record<RateAgentId, string | null> = { claude: null, codex: null }
  private readonly oauthExpiresAt: Record<RateAgentId, number | null> = { claude: null, codex: null }
  private readonly extras: Record<RateAgentId, readonly RateExtra[]> = { claude: [], codex: [] }
  private readonly raw: Record<RateAgentId, unknown> = { claude: null, codex: null }
  private readonly inFlight = new Map<RateAgentId, Promise<void>>()
  /**
   * Providers whose push arrived while a read was already out.
   *
   * That read answers with the state from before the push, so merging into it loses what the push
   * was about. One repeat when it lands is enough, and the flag is cleared before the repeat starts.
   */
  private readonly nudgedMidRead = new Set<RateAgentId>()
  private readonly nudgedReadAt: Record<RateAgentId, number | null> = { claude: null, codex: null }
  private readonly nudgedWhileHidden = new Set<RateAgentId>()
  private snapshotValue: RateMonitorSnapshot
  private serializedValue: string
  private revision = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private visible = false
  private started = false
  private stopped = false

  constructor(private readonly deps: RateMonitorDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.cacheFile = deps.cacheFile
      ?? OrchestratorPaths.rateMonitorCacheFile(deps.configIdentity, deps.channel)
    this.cache = new RateMonitorCacheStore(this.cacheFile)
    const hooks: RateSourceHooks = { nudge: (agentId) => this.nudge(agentId) }
    const sources = deps.sources?.(hooks) ?? RateMonitorSources.of(hooks)
    this.sources = new Map(sources.map((source) => [source.agentId, source]))
    this.serializedValue = JSON.stringify(this.providers)
    this.snapshotValue = this.composeSnapshot()
  }

  /**
   * Hydrates from the cache, and then lets the cadence run if a window is already on screen. No
   * network is touched by the hydration itself on purpose: a read costs a request against an endpoint
   * that counts them, and what is on disk is the same answer one interval ago.
   *
   * The tail matters because a client builds its windows before it starts this: `setWindowVisible`
   * had nothing to arm at the time it was told, so the arming lands here. `readDue` is what keeps the
   * restart loop cheap - a cached success younger than one interval is not read again.
   */
  async start(): Promise<void> {
    // One-shot, because `stop()` ends the provider sources for good: `CodexAppServerClient.stop()`
    // sets its own stopped flag and answers a failure to everything after it. A second start would
    // therefore come up with a Codex provider that can only ever say `failed`, silently.
    if (this.stopped)
      throw new Error('A stopped rate monitor cannot be started again')
    if (this.started) return
    this.started = true
    try {
      const cached = await this.cache.load()
      if (cached !== null) {
        this.hydrate(cached)
        this.changed()
      }
    } catch (error) {
      this.deps.onError(`The rate monitor could not start: ${ErrorText.of(error)}`)
    }
    if (!this.started || !this.visible) return
    this.detach(this.readDue())
    this.arm()
  }

  /** Idempotent. Stops the timer and the sources, which is what ends a live provider child process. */
  stop(): void {
    this.stopped = true
    if (!this.started) return
    this.started = false
    this.visible = false
    this.clearTimer()
    for (const source of this.sources.values()) source.stop()
  }

  setWindowVisible(visible: boolean): void {
    if (this.stopped || this.visible === visible) return
    this.visible = visible
    if (!visible) {
      this.clearTimer()
      return
    }
    this.detach(this.readDue())
    this.arm()
  }

  snapshot(): RateMonitorSnapshot {
    return this.snapshotValue
  }

  /**
   * The manual read. Codex always, Claude only past its floor, and the snapshot is answered once the
   * reads have settled - so a caller never has to race the event it would otherwise wait for.
   */
  async refresh(): Promise<RateMonitorSnapshot> {
    await this.readAll()
    return this.snapshotValue
  }

  /**
   * Everything this subsystem is holding, for the one surface built to look at it. Composed out of
   * state that is already here: no I/O and no timer of its own, so the freshness of these facts is
   * the freshness of the single cadence above, which is itself one of the facts.
   */
  debugStatus(): RateMonitorDebugStatus {
    return {
      capturedAt: this.now(),
      poll: {
        windowVisible: this.visible,
        cadenceMilliseconds: RateMonitor.pollMillisecondsConst,
        claudeFloorMilliseconds: RateMonitor.claudeFloorMillisecondsConst,
      },
      providers: {
        claude: this.debugProviderOf('claude'),
        codex: this.debugProviderOf('codex'),
      },
    }
  }

  /**
   * Field by field and never a spread. `RateProviderDebug` has no field for a credential, so this is
   * the seam that makes carrying one impossible rather than merely forbidden: a source holding a
   * token has nowhere to put it, and a spread is what would have found somewhere.
   */
  private debugProviderOf(agentId: RateAgentId): RateProviderDebug {
    return {
      state: this.providers[agentId],
      lastAttemptAt: this.attemptAt[agentId],
      lastSuccessAt: this.successAt[agentId],
      lastReason: this.lastReason[agentId],
      oauthExpiresAt: this.oauthExpiresAt[agentId],
      extras: this.extras[agentId],
      raw: this.raw[agentId],
    }
  }

  /**
   * A push from a provider: one coalesced read of THAT provider, and nobody else's cadence moves.
   *
   * While nothing is visible the read is not made but the signal is not thrown away either. Reading
   * would break the one promise this cadence makes, and dropping it would leave a value the provider
   * has just said is wrong on screen until the next interval - so the provider is remembered as due
   * and read the moment a window comes back, however recently it last succeeded.
   *
   * Past the floor above the push is dropped rather than deferred: what it says is that the answer
   * moved, and the read a few seconds ago already asked for the answer. The cadence collects whatever
   * moved after it.
   */
  private nudge(agentId: RateAgentId): void {
    // A push arrives inside a `'line'` listener on a provider child's stdout, where a throw has no
    // caller at all: it becomes an uncaught exception and ends the process this library is linked
    // into. The same reason `detach` exists for the asynchronous half.
    try { this.takePush(agentId) }
    catch (error) {
      this.deps.onError(`A ${agentId} rate push could not be taken: ${ErrorText.of(error)}`)
    }
  }

  private takePush(agentId: RateAgentId): void {
    if (!this.visible) {
      this.nudgedWhileHidden.add(agentId)
      return
    }
    const now = this.now()
    const last = this.nudgedReadAt[agentId]
    if (last !== null && now - last < RateMonitor.nudgeFloorMillisecondsConst) return
    this.nudgedReadAt[agentId] = now
    // A read already on its way to the server left BEFORE this push, so its answer is the state from
    // before whatever the push is about. Merging into it counted the notification as served and put
    // the floor down for another five seconds, and the bar then held the old percentage for up to a
    // whole poll interval - in exactly the situation the push exists for. Remembered here and acted
    // on when that read lands.
    if (this.inFlight.has(agentId)) this.nudgedMidRead.add(agentId)
    this.detach(this.readProvider(agentId))
  }

  private async tick(): Promise<void> {
    if (!this.visible) return
    try {
      await this.readAll()
    } finally {
      this.arm()
    }
  }

  private async readAll(): Promise<void> {
    await Promise.all([...this.sources.keys()].map((agentId) => this.readProvider(agentId)))
  }

  /**
   * Only what one interval has left behind, plus whoever pushed while nobody was looking. Everything
   * else is still what the last round said, and showing a window is not a reason to ask an endpoint
   * the same question again.
   */
  private async readDue(): Promise<void> {
    const now = this.now()
    const due = [...this.sources.keys()].filter((agentId) => {
      if (this.nudgedWhileHidden.has(agentId)) return true
      const success = this.successAt[agentId]
      return success === null || now - success >= RateMonitor.pollMillisecondsConst
    })
    this.nudgedWhileHidden.clear()
    await Promise.all(due.map((agentId) => this.readProvider(agentId)))
  }

  /**
   * The one funnel every read passes through, so the floor and the de-duplication are stated once. A
   * second caller arriving while a read is in flight is handed THAT promise: a burst of Codex
   * notifications is one read, and a click on the widget during the poll's own read waits for it
   * instead of doubling it.
   */
  private readProvider(agentId: RateAgentId): Promise<void> {
    if (!this.started) return Promise.resolve()
    const running = this.inFlight.get(agentId)
    if (running) return running
    if (this.flooredOut(agentId)) return Promise.resolve()
    const work = this.runRead(agentId).finally(() => {
      this.inFlight.delete(agentId)
      // Exactly once: the flag is cleared before the repeat, so a push arriving during THAT read
      // sets it again and a stream of them cannot chain reads without end.
      if (!this.nudgedMidRead.delete(agentId)) return
      this.nudgedReadAt[agentId] = null
      this.detach(this.readProvider(agentId))
    })
    this.inFlight.set(agentId, work)
    return work
  }

  private flooredOut(agentId: RateAgentId): boolean {
    if (agentId === 'codex') return false
    else if (agentId === 'claude') {
      const attempt = this.attemptAt.claude
      return attempt !== null && this.now() - attempt < RateMonitor.claudeFloorMillisecondsConst
    }
    else throw new Error(`Unknown rate agent: ${JSON.stringify(agentId)}`)
  }

  private async runRead(agentId: RateAgentId): Promise<void> {
    const source = this.sources.get(agentId)
    if (source === undefined) return
    this.attemptAt[agentId] = this.now()
    let reading: RateSourceReading
    try {
      reading = await source.read()
    } catch (error) {
      // The contract is that a source answers rather than throws. One that broke it must not take the
      // poll, the last good windows or the other provider's read down with it.
      reading = { kind: 'failed', reason: ErrorText.of(error), oauthExpiresAt: null }
      this.deps.onError(`Reading the ${agentId} rate limits threw: ${ErrorText.of(error)}`)
    }
    this.apply(agentId, reading)
    // Every read and not only a success: what the cache owes the next start is the ATTEMPT time too.
    this.save()
    this.changed()
  }

  /**
   * Field by field and never a spread, on the seam a credential would have to cross: a reading is
   * built out of a file this process may only read, and a spread would carry whatever else it holds.
   */
  private apply(agentId: RateAgentId, reading: RateSourceReading): void {
    this.oauthExpiresAt[agentId] = reading.oauthExpiresAt
    if (reading.kind === 'ok') {
      const fetchedAt = this.now()
      this.lastReason[agentId] = null
      this.successAt[agentId] = fetchedAt
      this.extras[agentId] = reading.extras
      this.raw[agentId] = reading.raw
      // An answer carrying no windows adds none, and the entry already held keeps its own moment.
      // Both mappers are deliberately tolerant enough to return an empty list for a body whose
      // shape moved, so treating that as authoritative would let one renamed field erase the
      // numbers from memory and from the cache file in the same step - which is the promise above.
      const previous = this.lastGood.get(agentId)
      if (reading.windows.length === 0 && previous !== undefined)
        this.providers[agentId] = { kind: 'ok', fetchedAt: previous.fetchedAt, windows: previous.windows }
      else {
        this.lastGood.set(agentId, { fetchedAt, windows: reading.windows, extras: reading.extras })
        this.providers[agentId] = { kind: 'ok', fetchedAt, windows: reading.windows }
      }
    }
    else if (reading.kind === 'unconfigured') {
      this.lastReason[agentId] = reading.reason
      this.providers[agentId] = { kind: 'unconfigured', reason: reading.reason }
    }
    else if (reading.kind === 'failed') {
      this.lastReason[agentId] = reading.reason
      // A failure never destroys the last known windows. What a surface draws while a provider is
      // unreachable is the last thing that provider actually said, marked as old.
      const last = this.lastGood.get(agentId)
      this.providers[agentId] = {
        kind: 'stale',
        fetchedAt: last?.fetchedAt ?? null,
        windows: last?.windows ?? [],
        reason: reading.reason,
      }
    }
    else throw new Error(`Unknown rate reading: ${JSON.stringify(reading)}`)
  }

  /**
   * Windows only a success writes, and a provider that never answered leaves none to hydrate from.
   * The ATTEMPT time is written by every read, which is the whole point: a development restart loop
   * against an endpoint that is currently refusing writes no windows at all, and without this the
   * floor those restarts exist to be held by would begin again at each one.
   */
  private save(): void {
    try {
      this.cache.save({
        providers: { claude: this.lastGood.get('claude'), codex: this.lastGood.get('codex') },
        attempts: {
          claude: this.attemptAt.claude ?? undefined,
          codex: this.attemptAt.codex ?? undefined,
        },
      })
    } catch (error) {
      this.deps.onError(
        `The rate monitor cache at ${this.cacheFile} could not be written `
        + `(${ErrorText.of(error)}); the next start draws nothing until a read answers`,
      )
    }
  }

  private hydrate(cached: RateMonitorCacheContent): void {
    this.hydrateProvider('claude', cached)
    this.hydrateProvider('codex', cached)
  }

  /**
   * The cached windows come back as `ok` carrying the moment they were actually read at, never now: a
   * tooltip saying "three hours ago" is then telling the truth, and `readDue` reads that same field,
   * which is what makes a cache younger than one interval skip the first read after a start.
   *
   * The attempt is hydrated on its own, because a provider may have been asked without ever
   * answering: that run is what leaves a floor to honour and no windows to carry it.
   */
  private hydrateProvider(agentId: RateAgentId, cached: RateMonitorCacheContent): void {
    // Every gate here subtracts a persisted moment from `now()`, so one that is AHEAD of now never
    // elapses: a future attempt floors Claude for good and a future success is never due again,
    // while the tooltip reports it as read moments ago. A clock corrected backwards and a cache
    // file copied from a machine that was ahead both produce it. Dropping one costs a read.
    const now = this.now()
    const attempt = cached.attempts[agentId] ?? null
    this.attemptAt[agentId] = attempt !== null && attempt <= now ? attempt : null
    const entry: RateMonitorCacheEntry | undefined = cached.providers[agentId]
    if (entry === undefined || entry.fetchedAt > now) return
    this.successAt[agentId] = entry.fetchedAt
    this.extras[agentId] = entry.extras
    this.lastGood.set(agentId, entry)
    this.providers[agentId] = { kind: 'ok', fetchedAt: entry.fetchedAt, windows: entry.windows }
  }

  /**
   * The whole composed value is compared, `fetchedAt` included: a provider that answered `ok` at a new
   * moment did move, and how old an answer is is something a surface draws. What the gate actually
   * silences is the provider answering the same nothing - `unconfigured`, or `stale` with the same
   * reason - which on a machine without one of the two agents is every poll it will ever make.
   */
  private changed(): void {
    const serialized = JSON.stringify(this.providers)
    if (serialized === this.serializedValue) return
    this.serializedValue = serialized
    this.revision += 1
    this.snapshotValue = this.composeSnapshot()
    this.deps.onChanged()
  }

  /** Field by field: the snapshot is the one value of this subsystem's that reaches every window. */
  private composeSnapshot(): RateMonitorSnapshot {
    return {
      revision: this.revision,
      providers: { claude: this.providers.claude, codex: this.providers.codex },
    }
  }

  private arm(): void {
    this.clearTimer()
    if (!this.started || !this.visible) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.detach(this.tick())
    }, RateMonitor.pollMillisecondsConst)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * The end of every promise nobody is waiting for. A timer and a nudge have no caller to report to,
   * and an unhandled rejection out of one of them takes down the process this library is linked into.
   */
  private detach(work: Promise<unknown>): void {
    void work.catch((error: unknown) => {
      this.deps.onError(`The rate monitor failed: ${ErrorText.of(error)}`)
    })
  }
}
