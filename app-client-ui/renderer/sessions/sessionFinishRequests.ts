/**
 * A Finish asked for outside the sessions tree, by a tab's menu. The tree owns what Finish does (the
 * dialog, the prepare, the workflow it brings forward, the in-flight guard), so the request is handed
 * to the row rather than answered a second time here.
 */
export class SessionFinishRequests {
  private readonly handlers = new Set<(sessionId: string) => boolean>()

  /** `handler` answers whether it took the request: false where it draws no row for that session. */
  subscribe(handler: (sessionId: string) => boolean): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  /** False where nothing took it, so the caller says so rather than doing nothing. */
  request(sessionId: string): boolean {
    for (const handler of this.handlers)
      if (handler(sessionId)) return true
    return false
  }
}
