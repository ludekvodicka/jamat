import type { AutomationState } from '../../sessionManager/sessionManagerApi.types'
import type { SnapinPresentationPort } from '../snapinsApi.types'
import type { AttemptRecord } from './snapinContract'
import type { TickGuard } from './tickGuard'

export class Presentation {
  private readonly port: SnapinPresentationPort
  private readonly now: () => number
  private readonly stopped: () => boolean

  constructor(port: SnapinPresentationPort, now: () => number, stopped: () => boolean) {
    this.port = port
    this.now = now
    this.stopped = stopped
  }

  static of(attempt: AttemptRecord): { state: AutomationState; note: string } | null {
    switch (attempt.phase) {
      case 'pending': return { state: 'working', note: 'Starting' }
      case 'working': return { state: 'working', note: 'Working' }
      case 'waiting': {
        const waiting = attempt.outcome?.waiting
        switch (waiting) {
          case 'deploy': case 'foreign-deploy': return { state: 'waiting', note: 'Waits for deploy' }
          case undefined: case 'user': case 'blocked': return { state: 'waiting', note: 'Waits for your answer' }
          default: throw new Error(`Unknown waiting reason ${waiting}`)
        }
      }
      case 'review': return { state: 'waiting', note: 'Waits for your review: Finish or commit' }
      case 'blocked': return { state: 'blocked', note: `Blocked: ${(attempt.outcome?.detail ?? '').split(/\r?\n/, 1)[0]!.slice(0, 200)}` }
      case 'completed': return { state: 'completed', note: 'Done' }
      case 'ended': return null
      default: throw new Error(`Unknown attempt phase ${attempt.phase}`)
    }
  }

  async apply(kind: string, attempt: AttemptRecord, guard: TickGuard): Promise<void> {
    if ((attempt.presentedPhase === attempt.phase && attempt.presentationRetryAt === undefined) || (attempt.presentationRetryAt !== undefined && this.now() < attempt.presentationRetryAt)
      || !guard.open(kind) || this.stopped()) return
    const value = Presentation.of(attempt)
    let success = true
    if (value && attempt.sessionId) {
      try {
        const written = await this.port.setState(attempt.sessionId, value.state)
        if (!guard.open(kind) || this.stopped()) return
        switch (written) {
          case 'ok': {
            const note = await this.port.setNote(attempt.sessionId, value.note)
            success = note === 'ok' || note === 'missing-session'
            break
          }
          case 'missing-session': break
          case 'failed': success = false; break
          default: throw new Error(`Unknown presentation state write ${written satisfies never}`)
        }
      } catch { success = false }
    }
    if (!guard.open(kind) || this.stopped()) return
    await guard.write(kind, (doc) => {
      const current = doc.attempts.find((a) => a.attemptId === attempt.attemptId)!
      if (success) {
        current.presentedPhase = current.phase
        delete current.presentationRetryAt
      } else current.presentationRetryAt = this.now() + 60_000
      return doc
    })
  }
}
