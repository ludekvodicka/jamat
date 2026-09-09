export class HostOperationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HostOperationError'
  }

  /**
   * A failed controller lease check is always a conflict. Both services wrap it, so the wrap lives
   * here rather than being copied into each of the four call sites that need it.
   */
  static conflictFrom(error: unknown): HostOperationError {
    return new HostOperationError(409, error instanceof Error ? error.message : String(error))
  }
}
