import type { SessionsOpResult } from './sessionManagerApi.types'

/**
 * How a review ended. A numeric `revision` is the receipt; `'1234, 1235'` names several scopes and
 * is no receipt of one.
 */
export type SessionReviewSettled =
  | { state: 'committed'; revision: string }
  | { state: 'cancelled' }
  /** The person took the review to an external client; its exit proves neither a commit nor a cancel. */
  | { state: 'external-closed' }
  /** A failed attempt that the person then closed. */
  | { state: 'failed'; reason: string; outOfDate: boolean }
  /** The review is unknown to the commit dialog; its outcome is unknown. */
  | { state: 'lost' }

/** The commit dialog of the client, bound late because the client builds it after the sessions. */
export interface SessionReviewPort {
  open(input: { sessionId: string; scopeRoot: string; proposal: string }): Promise<SessionsOpResult<{ commitSessionId: string }>>
  /** Rejects once `signal` aborts, which is how a stopping client stops waiting for a person. */
  settled(commitSessionId: string, signal: AbortSignal): Promise<SessionReviewSettled>
}
