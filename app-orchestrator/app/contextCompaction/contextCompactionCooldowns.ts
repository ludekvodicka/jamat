import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ContextCompactionCooldown } from '../../../lib-orchestrator/clientApi/contextCompactionCooldown'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

/**
 * The ten-minute pause after a `/compact` request, per session. It is on disk because it was only in
 * memory: a client restart during a running compaction cleared it, and the next check sent a second
 * `/compact`, which the agent queued and ran right after the first (2026-11-16, session 047).
 * `file` null keeps it in memory only.
 */
export class ContextCompactionCooldowns {
  static readonly durationMillisecondsConst = 10 * 60_000
  private static readonly schemaVersionConst = 1
  private readonly file: string | null
  private readonly report: (message: string) => void
  private readonly now: () => number
  private readonly expiries: Map<string, number>

  constructor(file: string | null, report: (message: string) => void, now: () => number = Date.now) {
    this.file = file
    this.report = report
    this.now = now
    this.expiries = file === null ? new Map() : this.load(file)
  }

  /** Reserves the pause for an automatic request; false while one holds it. */
  claim(sessionId: string): boolean {
    this.prune()
    if ((this.expiries.get(sessionId) ?? 0) > this.now()) return false
    this.start(sessionId)
    return true
  }

  /** A manual request always goes, and restarts the pause. */
  note(sessionId: string): void {
    this.prune()
    this.start(sessionId)
  }

  read(sessionId: string): ContextCompactionCooldown | null {
    this.prune()
    const expiresAt = this.expiries.get(sessionId)
    return expiresAt === undefined ? null
      : { requestedAt: expiresAt - ContextCompactionCooldowns.durationMillisecondsConst, expiresAt }
  }

  private start(sessionId: string): void {
    this.expiries.set(sessionId, this.now() + ContextCompactionCooldowns.durationMillisecondsConst)
    this.save()
  }

  private prune(): void {
    const now = this.now()
    for (const [sessionId, expiresAt] of this.expiries)
      if (expiresAt <= now) this.expiries.delete(sessionId)
  }

  private save(): void {
    if (this.file === null) return
    try {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      AtomicJsonFile.write(this.file, { schemaVersion: ContextCompactionCooldowns.schemaVersionConst, expiries: Object.fromEntries(this.expiries) })
    } catch (error) {
      this.report(`Compact pauses could not be saved; a restart forgets them: ${ErrorText.of(error)}`)
    }
  }

  /** An unreadable file starts empty: the worst case is the one extra `/compact` this file prevents. */
  private load(file: string): Map<string, number> {
    let text: string
    try { text = readFileSync(file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(`Compact pauses could not be read: ${ErrorText.of(error)}`)
      return new Map()
    }
    const now = this.now()
    const latest = now + ContextCompactionCooldowns.durationMillisecondsConst
    try {
      const parsed = JsonShape.record(JSON.parse(text))
      const expiries = JsonShape.record(parsed?.expiries)
      if (parsed?.schemaVersion !== ContextCompactionCooldowns.schemaVersionConst || expiries === null)
        throw new Error('unknown shape')
      // A clock moved back must not stretch a pause past its ten minutes.
      return new Map(Object.entries(expiries).flatMap(([sessionId, expiresAt]) =>
        typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now ? [[sessionId, Math.min(expiresAt, latest)] as const] : []))
    } catch (error) {
      this.report(`Compact pauses in ${file} are unreadable and start empty: ${ErrorText.of(error)}`)
      return new Map()
    }
  }
}
