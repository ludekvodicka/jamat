/**
 * The one place an `unknown` becomes a message. It is a pure function with no Electron and no DOM,
 * so the main process, the preload and the renderer all read the same text for the same failure.
 */
export class ErrorText {
  static of(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** For a failure nobody is left to explain: the top-level handler, where the stack locates it. */
  static detailOf(error: unknown): string {
    return error instanceof Error ? error.stack ?? error.message : String(error)
  }
}
