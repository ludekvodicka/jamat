/** Which plain window refused the request. `other` is a limit type this build does not know. */
export type LimitWindow = 'session' | 'weekly' | 'other'

/** What the last turn of a session's transcript says about a usage limit. */
export type LimitReading =
  | { kind: 'none' }
  | { kind: 'limit'; recordId: string; at: number; window: LimitWindow; resetsAt: number | null }

export interface LimitAccountRef { accountId: string; label: string }

/** The limit a session stopped on, as the popup draws it. Times are epoch milliseconds. */
export interface LimitFact {
  account: LimitAccountRef
  window: LimitWindow
  resetsAt: number | null
}

/** `switch` moves the session to another account; `resume` continues on its own account after a reset. */
export type LimitRecoveryReason = 'switch' | 'resume'

/**
 * One session's recovery after a usage limit, drawn by its terminal tab. `stopsBackgroundShells`:
 * the switch restarts a session whose shells run in the background, and the restart ends them.
 */
export type SessionLimitRecoveryInfo =
  | { state: 'countdown'; limit: LimitFact; reason: LimitRecoveryReason; target: LimitAccountRef; deadlineAt: number; stopsBackgroundShells?: true }
  | { state: 'queued'; limit: LimitFact; reason: LimitRecoveryReason; target: LimitAccountRef; position: number; stopsBackgroundShells?: true }
  | { state: 'running'; limit: LimitFact; reason: LimitRecoveryReason; target: LimitAccountRef; stopsBackgroundShells?: true }
  | { state: 'waiting'; limit: LimitFact; wakeAt: number | null; nextAccount: LimitAccountRef | null }
  | { state: 'failed'; limit: LimitFact; detail: string }

export type LimitRecoveryAction = 'now' | 'cancel' | 'dismiss'
