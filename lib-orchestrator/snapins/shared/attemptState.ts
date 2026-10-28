import type { SessionInfo, SessionsSnapshot } from '../../sessionManager/sessionManagerApi.types'
import type { AttemptRecord, SnapinStateDocument } from './snapinContract'

export function sessionOf(attempt: AttemptRecord, snapshot: SessionsSnapshot): SessionInfo | undefined {
  return snapshot.sessions.find((session) => session.sessionId === attempt.sessionId)
    ?? snapshot.sessions.find((session) => session.callerOperationId === attempt.attemptId)
}

export function setupRunning(session: SessionInfo | undefined): boolean {
  return session?.scripts?.runs.some((run) => run.phase === 'before' && run.state === 'running') ?? false
}

export function newestOf(doc: SnapinStateDocument, itemKey: string): AttemptRecord | undefined {
  return doc.attempts.filter((attempt) => attempt.itemKey === itemKey).at(-1)
}

export function holderOf(doc: SnapinStateDocument, itemKey: string): AttemptRecord | undefined {
  return doc.attempts.find((attempt) => attempt.itemKey === itemKey && attempt.leaseHeld)
}

export function endAttempt(doc: SnapinStateDocument, attempt: AttemptRecord, reason: string, now: number): void {
  attempt.phase = 'ended'
  attempt.endedReason = reason
  attempt.endedAt = now
  delete attempt.attention
  if (reason.startsWith('create-refused:') || reason === 'never-created') {
    if (attempt.leaseHeld && attempt.leaseFrom) {
      const predecessor = doc.attempts.find((a) => a.attemptId === attempt.leaseFrom)
      if (predecessor) predecessor.leaseHeld = true
    }
    attempt.leaseHeld = false
  } else if (reason === 'released' || reason === 'discarded') attempt.leaseHeld = false
}
