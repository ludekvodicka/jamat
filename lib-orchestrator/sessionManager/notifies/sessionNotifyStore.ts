import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { JsonNumber } from '../../shared/jsonNumber'
import { JsonShape } from '../../shared/jsonShape'
import type { SessionCreateSpec, SessionNotifyCause, SessionNotifyDto, SessionNotifyEventDto } from '../sessionManagerApi.types'
import type { NotifyObservation, NotifySource, PendingNotify } from './sessionNotifier'

export type SessionNotifySpec = NonNullable<SessionCreateSpec['notify']>

export type { SessionNotifyCause } from '../sessionManagerApi.types'

export interface SessionNotifyEvent extends SessionNotifyEventDto {
  id: string
}

export interface SessionNotifyRecord {
  sessionId: string
  target: string
  text: string
  onGroups: string[]
  seenLife: NotifyObservation['life']
  seenGroup: string | null
  endedAt: number | null
  events: SessionNotifyEvent[]
}

export class SessionNotifyStore implements NotifySource {
  static readonly keepMillisecondsConst = 30 * 86_400_000
  private static readonly plainIdConst = /^[A-Za-z0-9_-]{1,128}$/
  private readonly directory: string
  private readonly now: () => number
  private readonly report: (message: string) => void
  private readonly records: Map<string, SessionNotifyRecord>
  private loading: Promise<void> | null
  private writes: Promise<unknown>

  constructor(directory: string, deps: { now: () => number; report: (message: string) => void }) {
    this.directory = directory
    this.now = deps.now
    this.report = deps.report
    this.records = new Map()
    this.loading = null
    this.writes = Promise.resolve()
  }

  load(): Promise<void> {
    this.loading ??= this.serialized(async () => {
      await this.read()
      for (const record of this.records.values()) {
        if (record.seenLife !== 'gone' || record.endedAt === null
          || this.now() < record.endedAt + SessionNotifyStore.keepMillisecondsConst
          || record.events.some((event) => event.state === 'pending')) continue
        await rm(this.fileOf(record.sessionId), { force: true })
        this.records.delete(record.sessionId)
      }
    }).catch((error: unknown) => this.report(`Session notifies at ${this.directory} could not be swept: ${ErrorText.of(error)}`))
    return this.loading
  }

  async watch(sessionId: string, spec: SessionNotifySpec): Promise<void> {
    if (!SessionNotifyStore.plainIdConst.test(sessionId)) throw new Error(`Not a plain id: ${JSON.stringify(sessionId)}`)
    await this.load()
    await this.serialized(async () => {
      if (this.records.has(sessionId)) return
      await this.write({
        sessionId, target: spec.sessionId, text: spec.text, onGroups: [...spec.onGroups],
        seenLife: 'live', seenGroup: null, endedAt: null, events: [],
      })
    })
  }

  watched(): readonly SessionNotifyRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record))
  }

  async observe(sessionId: string, seen: NotifyObservation, at: number): Promise<SessionNotifyCause[]> {
    await this.load()
    return this.serialized(async () => {
      const record = this.records.get(sessionId)
      if (record === undefined || (record.seenLife === seen.life && record.seenGroup === seen.group)) return []
      const causes: SessionNotifyCause[] = []
      let endedAt: number | null
      if (seen.life === 'gone') {
        endedAt = record.endedAt ?? at
        if (record.seenLife === 'live') causes.push('ended')
      } else if (seen.life === 'live') endedAt = null
      else throw new Error(`Unknown observed life: ${JSON.stringify(seen.life satisfies never)}`)
      if (seen.group !== record.seenGroup && seen.group !== null && record.onGroups.includes(seen.group))
        causes.push(`group:${seen.group}`)
      await this.write({
        ...record, seenLife: seen.life, seenGroup: seen.group, endedAt,
        events: [...record.events, ...causes.map((cause): SessionNotifyEvent => ({
          id: randomUUID(), cause, at, state: 'pending', attempts: 0, settledAt: null,
        }))],
      })
      return causes
    })
  }

  pending(): PendingNotify[] {
    return [...this.records.values()].flatMap((record) => record.events
      .filter((event) => event.state === 'pending')
      .map((event) => ({ id: event.id, sessionId: record.target, text: record.text, at: event.at, attempts: event.attempts })))
  }

  async note(ids: readonly string[], state: 'delivered' | 'attempted' | 'expired', at: number): Promise<void> {
    await this.load()
    await this.serialized(async () => {
      const selected = new Set(ids)
      for (const record of this.records.values()) {
        if (!record.events.some((event) => selected.has(event.id) && event.state === 'pending')) continue
        const events = record.events.map((event): SessionNotifyEvent => {
          if (!selected.has(event.id) || event.state !== 'pending') return event
          if (state === 'attempted') return { ...event, attempts: event.attempts + 1 }
          else if (state === 'delivered' || state === 'expired') return { ...event, state, settledAt: at }
          else throw new Error(`Unknown notify state: ${JSON.stringify(state satisfies never)}`)
        })
        await this.write({ ...record, events })
      }
    })
  }

  list(filter: { sessionId?: string }): SessionNotifyDto[] {
    return this.watched().filter((record) => filter.sessionId === undefined || record.sessionId === filter.sessionId)
      .map((record) => ({
        sessionId: record.sessionId, target: record.target, text: record.text, onGroups: record.onGroups,
        events: record.events.map(({ cause, at, state, attempts, settledAt }) => ({ cause, at, state, attempts, settledAt })),
      }))
  }

  private async read(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if (ErrnoCode.of(error) !== 'ENOENT') this.report(`Session notifies at ${this.directory} could not be read: ${ErrorText.of(error)}`)
      return
    }
    for (const name of names) {
      const sessionId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null
      if (sessionId === null || !SessionNotifyStore.plainIdConst.test(sessionId)) continue
      try {
        const record = SessionNotifyStore.parsed(JSON.parse(await readFile(join(this.directory, name), 'utf8')), sessionId)
        if (record === null) this.report(`Session notifies at ${this.directory}: ${name} is not a notify record; it is left alone`)
        else this.records.set(sessionId, record)
      } catch (error) {
        this.report(`Session notifies at ${this.directory}: ${name} could not be read (${ErrorText.of(error)}); it is left alone`)
      }
    }
  }

  private async write(record: SessionNotifyRecord): Promise<void> {
    await AtomicJsonFile.ensureDirectoryAsync(this.directory)
    await AtomicJsonFile.writeAsync(this.fileOf(record.sessionId), record)
    this.records.set(record.sessionId, record)
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work)
    this.writes = next.catch(() => undefined)
    return next
  }

  private fileOf(sessionId: string): string {
    return join(this.directory, `${sessionId}.json`)
  }

  private static parsed(value: unknown, sessionId: string): SessionNotifyRecord | null {
    const record = JsonShape.record(value)
    if (record === null || record.sessionId !== sessionId
      || typeof record.target !== 'string' || typeof record.text !== 'string'
      || !Array.isArray(record.onGroups) || !record.onGroups.every((group) => typeof group === 'string')
      || (record.seenGroup !== null && typeof record.seenGroup !== 'string')) return null
    if (record.seenLife === 'live') {
      if (record.endedAt !== null) return null
    } else if (record.seenLife === 'gone') {
      if (!JsonNumber.isFinite(record.endedAt)) return null
    } else return null
    if (!Array.isArray(record.events) || !record.events.every(SessionNotifyStore.isEvent)) return null
    if (new Set(record.events.map((event) => event.id)).size !== record.events.length) return null
    return record as unknown as SessionNotifyRecord
  }

  private static isEvent(value: unknown): value is SessionNotifyEvent {
    const event = JsonShape.record(value)
    if (event === null || typeof event.id !== 'string' || !SessionNotifyStore.plainIdConst.test(event.id)
      || typeof event.cause !== 'string' || (event.cause !== 'ended' && !/^group:.+$/.test(event.cause))
      || !JsonNumber.isFinite(event.at) || JsonNumber.wholeCount(event.attempts) === null) return false
    if (event.state === 'pending') return event.settledAt === null
    else if (event.state === 'delivered' || event.state === 'expired') return JsonNumber.isFinite(event.settledAt)
    else return false
  }
}
