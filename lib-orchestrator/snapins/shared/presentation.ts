import type { SnapinPresentationPort } from '../snapinsApi.types'
import type { AttemptRecord } from './snapinContract'
import type { TickGuard } from './tickGuard'

export class Presentation {
  private readonly port: SnapinPresentationPort
  private readonly now: () => number
  private readonly stopped: () => boolean
  private ensured: Promise<boolean> | null

  constructor(port: SnapinPresentationPort, now: () => number, stopped: () => boolean) {
    this.port = port
    this.now = now
    this.stopped = stopped
    this.ensured = null
  }

  beginTick(): void { this.ensured = null }

  static of(attempt: AttemptRecord): { group: string; note: string } | null {
    switch (attempt.phase) {
      case 'pending': return { group: 'automation', note: 'Starting' }
      case 'working': return { group: 'automation', note: 'Working' }
      case 'waiting': {
        const waiting = attempt.outcome?.waiting
        switch (waiting) {
          case 'deploy': case 'foreign-deploy': return { group: 'waiting', note: 'Waits for deploy' }
          case undefined: case 'user': case 'blocked': return { group: 'waiting', note: 'Waits for your answer' }
          default: throw new Error(`Unknown waiting reason ${waiting}`)
        }
      }
      case 'review': return { group: 'waiting', note: 'Waits for your review: Finish or commit' }
      case 'blocked': return { group: 'blocked', note: `Blocked: ${(attempt.outcome?.detail ?? '').split(/\r?\n/, 1)[0]!.slice(0, 200)}` }
      case 'completed': return { group: 'completed', note: 'Done' }
      case 'ended': return null
      default: throw new Error(`Unknown attempt phase ${attempt.phase}`)
    }
  }

  async apply(kind: string, attempt: AttemptRecord, guard: TickGuard, log: (text: string) => void): Promise<void> {
    if ((attempt.presentedPhase === attempt.phase && attempt.presentationRetryAt === undefined) || (attempt.presentationRetryAt !== undefined && this.now() < attempt.presentationRetryAt)
      || !guard.open(kind) || this.stopped()) return
    const value = Presentation.of(attempt)
    let success = true
    let missingGroup = false
    if (value && attempt.sessionId) {
      try {
        this.ensured ??= this.port.ensureGroups().catch(() => false)
        const ensured = await this.ensured
        if (!guard.open(kind) || this.stopped()) return
        const assigned = this.port.assign(attempt.sessionId, value.group)
        if (assigned !== 'missing-session') {
          missingGroup = assigned === 'missing-group' && !ensured
          const note = await this.port.setNote(attempt.sessionId, value.note)
          if (assigned === 'ok' || assigned === 'missing-group' || assigned === 'failed')
            success = note === 'missing-session' || (note === 'ok' && (assigned === 'ok' || missingGroup))
          else throw new Error(`Unknown presentation assignment ${assigned}`)
        }
      } catch { success = false }
    }
    if (!guard.open(kind) || this.stopped()) return
    const written = await guard.write(kind, (doc) => {
      const current = doc.attempts.find((a) => a.attemptId === attempt.attemptId)!
      if (success) {
        current.presentedPhase = current.phase
        delete current.presentationRetryAt
      } else current.presentationRetryAt = this.now() + 60_000
      return doc
    })
    if (written && missingGroup) log(`Attempt ${attempt.attemptId}: presentation group missing; could not restore it`)
  }
}
