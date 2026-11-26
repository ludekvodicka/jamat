import { readFileSync, renameSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { SessionClaims } from './sessionClaims'
import { transcriptCursorSchema } from './transcriptCursor'

const time = z.number().finite()
const pathClaimSchema = z.object({
  path: z.string(),
  source: z.enum(['tool', 'shell', 'status']),
  lastWriteAt: time,
  settledAt: time.nullable(),
})
const shellRunSchema = z.object({ command: z.string(), startedAt: time, endedAt: time })
const sessionSchema = z.object({
  /** Every conversation id seen for the Jamat session, oldest first. */
  nativeIds: z.array(z.string()),
  /** Transcript file to where its reading stopped. */
  cursors: z.record(z.string(), transcriptCursorSchema),
  claims: z.array(pathClaimSchema),
  shellRuns: z.array(shellRunSchema).max(SessionClaims.maxShellRunsConst),
  /** The last time the session was a candidate. */
  seenAt: time,
})
const cacheSchema = z.object({
  schema: z.literal(1),
  sessions: z.record(z.string(), sessionSchema),
})

export type ClaimCacheSession = z.infer<typeof sessionSchema>
export type ClaimCacheContent = z.infer<typeof cacheSchema>

/**
 * `session-claims.json` (D8): the claims, transcript cursors, shell runs and conversation ids of each
 * Jamat session, so a restart or a `/clear` neither forgets earlier edits nor reads every transcript
 * again. Disposable: a missing or invalid file is an empty cache and the transcripts rebuild it. It
 * is written only after a change, at most once per minute, and once more on stop.
 */
export class ClaimCache {
  static readonly writeIntervalMillisecondsConst = 60_000
  /** The session record archive takes ended records after the same week. */
  static readonly absentMillisecondsConst = 7 * 24 * 60 * 60_000

  private readonly file: string
  private readonly now: () => number
  /** The text last read or written, so an unchanged content is never written. */
  private written: string | null = null
  private pending: ClaimCacheContent | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(file: string, now: () => number) {
    this.file = file
    this.now = now
  }

  static empty(): ClaimCacheContent {
    return { schema: 1, sessions: {} }
  }

  /** Whether a session last seen at `seenAt` is gone long enough to drop. */
  static expired(seenAt: number, now: number): boolean {
    return now - seenAt > ClaimCache.absentMillisecondsConst
  }

  /** Never throws: an invalid file is kept once beside it (`session-claims.invalid.json`) and the cache starts empty. */
  load(): ClaimCacheContent {
    let text: string
    try { text = readFileSync(this.file, 'utf8') }
    catch { return ClaimCache.empty() }
    let parsed: unknown
    try { parsed = JSON.parse(text) }
    catch { return this.invalid() }
    const value = cacheSchema.safeParse(parsed)
    if (!value.success) return this.invalid()
    this.written = JSON.stringify(value.data)
    return value.data
  }

  /** The content to write; the latest of several within the interval wins. */
  scheduleWrite(content: ClaimCacheContent): void {
    this.pending = content
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.writePending()
    }, ClaimCache.writeIntervalMillisecondsConst)
  }

  /** Writes a pending change at once; for the stop of the worker. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.writePending()
  }

  private writePending(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const content = this.pending
      this.pending = null
      if (content === null) return
      const now = this.now()
      const kept: ClaimCacheContent = {
        schema: 1,
        sessions: Object.fromEntries(Object.entries(content.sessions)
          .filter(([, session]) => !ClaimCache.expired(session.seenAt, now))),
      }
      const text = JSON.stringify(kept)
      if (text === this.written) return
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await AtomicJsonFile.writeAsync(this.file, kept, { compact: true })
        this.written = text
      }
      // A failed write leaves the last good file; the next change tries again.
      catch { /* the cache is disposable */ }
    })
    return this.writing
  }

  private invalid(): ClaimCacheContent {
    try { renameSync(this.file, `${this.file.replace(/\.json$/i, '')}.invalid.json`) }
    catch { /* the next write replaces it anyway */ }
    this.written = null
    return ClaimCache.empty()
  }
}
