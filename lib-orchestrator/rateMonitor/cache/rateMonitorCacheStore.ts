import { JsonNumber } from '../../shared/jsonNumber'
import { JsonShape } from '../../shared/jsonShape'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import type { RateAgentId, RateExtra, RateWindow } from '../rateMonitorApi.types'

/** One provider's last successful answer, reduced to what a surface draws. */
export interface RateMonitorCacheEntry {
  fetchedAt: number
  windows: readonly RateWindow[]
  extras: readonly RateExtra[]
}

export type RateMonitorCacheEntries = Readonly<Partial<Record<RateAgentId, RateMonitorCacheEntry>>>

export type RateMonitorCacheAttempts = Readonly<Partial<Record<RateAgentId, number>>>

/** Two different facts about a provider: what it last ANSWERED, and when it was last ASKED. */
export interface RateMonitorCacheContent {
  providers: RateMonitorCacheEntries
  attempts: RateMonitorCacheAttempts
}

/**
 * What is on disk. It carried a `savedAt` that `coerce` never read and that no consumer had a field
 * for - and it was the one read of the clock in this subsystem that went around the injected one, so
 * a document written under a test's clock carried one real timestamp beside simulated ones. A
 * document that still has the field simply loads without it.
 */
interface RateMonitorCacheDocument {
  schemaVersion: 1
  providers: RateMonitorCacheEntries
  attempts: RateMonitorCacheAttempts
}

/**
 * The last successful windows of both providers, so a client that has just opened has something
 * honest to draw, and so a restart loop during development does not spend a request against an
 * endpoint that refuses a client which asks too often.
 *
 * A cache and never a record: losing it costs the first draw and one read. That is why an unreadable
 * file is simply no cache - it is not reported, not latched and not repaired - and why only a
 * SUCCESS contributes windows, and only the part a surface draws. The raw response body stays in
 * memory.
 *
 * Beside them the moment each provider was last ASKED, which every read writes and no success is
 * needed for: a run of refusals is exactly when the floor above must survive a restart, and it is
 * exactly the run that stores no windows to carry the time with.
 */
export class RateMonitorCacheStore {
  private static readonly schemaVersionConst = 1

  constructor(private readonly file: string) {}

  async load(): Promise<RateMonitorCacheContent | null> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return null
    }
    try {
      return RateMonitorCacheStore.coerce(JSON.parse(raw))
    } catch {
      return null
    }
  }

  /** Atomic, the way every store in this library writes: a half-written cache reads as damage. */
  save(content: RateMonitorCacheContent): void {
    const document: RateMonitorCacheDocument = {
      schemaVersion: RateMonitorCacheStore.schemaVersionConst,
      providers: content.providers,
      attempts: content.attempts,
    }
    AtomicJsonFile.ensureDirectory(dirname(this.file))
    AtomicJsonFile.write(this.file, document)
  }

  private static coerce(parsed: unknown): RateMonitorCacheContent | null {
    // Read as unknown fields and narrowed one by one: a document off the disk is whatever somebody
    // wrote there, and typing it as the shape it is being checked FOR is the check answering itself.
    const document = JsonShape.record(parsed)
    if (document === null) return null
    if (document.schemaVersion !== RateMonitorCacheStore.schemaVersionConst) return null
    const record = JsonShape.record(document.providers)
    if (record === null) return null
    const entries: Partial<Record<RateAgentId, RateMonitorCacheEntry>> = {}
    const claude = RateMonitorCacheStore.entryOf(record.claude)
    if (claude) entries.claude = claude
    const codex = RateMonitorCacheStore.entryOf(record.codex)
    if (codex) entries.codex = codex
    // A document written before this section existed simply has none, and loads without it.
    return { providers: entries, attempts: RateMonitorCacheStore.attemptsOf(document.attempts) }
  }

  private static attemptsOf(value: unknown): RateMonitorCacheAttempts {
    const attempts: Partial<Record<RateAgentId, number>> = {}
    const record = JsonShape.record(value)
    if (record === null) return attempts
    if (JsonNumber.isFinite(record.claude)) attempts.claude = record.claude
    if (JsonNumber.isFinite(record.codex)) attempts.codex = record.codex
    return attempts
  }

  private static entryOf(value: unknown): RateMonitorCacheEntry | null {
    const entry = JsonShape.record(value)
    if (entry === null) return null
    const { fetchedAt, windows, extras } = entry
    // Without the moment it was read the entry cannot say how old it is, which is the one thing a
    // hydrated state has to be honest about.
    if (!JsonNumber.isFinite(fetchedAt)) return null
    return {
      fetchedAt,
      windows: RateMonitorCacheStore.listOf(windows, RateMonitorCacheStore.windowOf),
      extras: RateMonitorCacheStore.listOf(extras, RateMonitorCacheStore.extraOf),
    }
  }

  /** A single unusable member is dropped rather than costing the whole provider its cached answer. */
  private static listOf<T>(value: unknown, memberOf: (member: unknown) => T | null): readonly T[] {
    if (!Array.isArray(value)) return []
    const members: T[] = []
    for (const member of value) {
      const coerced = memberOf(member)
      if (coerced !== null) members.push(coerced)
    }
    return members
  }

  private static windowOf(value: unknown): RateWindow | null {
    const read = JsonShape.record(value)
    if (read === null) return null
    const { durationMinutes, usedPercent, resetsAt, model } = read
    if (!JsonNumber.isFinite(durationMinutes) || durationMinutes <= 0) return null
    if (!JsonNumber.isFinite(usedPercent)) return null
    const window: RateWindow = {
      durationMinutes,
      usedPercent,
      resetsAt: typeof resetsAt === 'string' ? resetsAt : null,
    }
    if (typeof model === 'string') window.model = model
    return window
  }

  private static extraOf(value: unknown): RateExtra | null {
    const read = JsonShape.record(value)
    if (read === null) return null
    const { label, detail } = read
    if (typeof label !== 'string' || typeof detail !== 'string') return null
    return { label, detail }
  }

}
