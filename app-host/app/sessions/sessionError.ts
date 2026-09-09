export type SessionErrorCode =
  | 'conflict'
  | 'invalid-request'
  | 'limit-exceeded'
  | 'not-found'

/**
 * A domain failure of the session lifecycle. The services map the code onto an HTTP status, so the
 * manager never needs to know what a status is.
 */
export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}
