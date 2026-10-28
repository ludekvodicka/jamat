/**
 * The Host could not prove that a stopped terminal and its owned children ended: the descendant
 * inspection failed, or an owned child did not die. The message says what the caller can do next.
 *
 * Like `TerminalLaunchError`, it exists so the session layer can map it onto the wire. Without it the
 * refusal read as an internal error, and a client could not tell a retryable Stop from a broken Host.
 */
export class TerminalStopRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalStopRefusal'
  }
}
