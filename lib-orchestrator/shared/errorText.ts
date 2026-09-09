/** The one place an `unknown` becomes a message, so every store in this library reports alike. */
export class ErrorText {
  static of(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
