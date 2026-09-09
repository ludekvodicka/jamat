/**
 * The child process did not start: the executable could not be spawned, or it never reached a
 * stable process identity.
 *
 * This is about the launch spec the caller supplied, not the Host's health, so it exists as its own
 * type for the session layer to map onto a 4xx. Without it every bad command reads as an internal
 * error and a client cannot tell "the command you gave me is wrong" from "the Host is broken".
 *
 * The terminal domain deliberately does not know about SessionError or HTTP: it reports what
 * happened, and the layer that owns the wire vocabulary decides what that means on the wire.
 */
export class TerminalLaunchError extends Error {
  constructor(message: string, readonly reason?: unknown) {
    super(message)
    this.name = 'TerminalLaunchError'
  }

  static describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
