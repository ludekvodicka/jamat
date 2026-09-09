/** Per renderer document, panels register the one session restart they need to hear about. */
export class SessionRefreshRegistry {
  private readonly refreshers = new Map<string, () => void>()

  registerRefresh(sessionId: string, onRestarted: () => void): () => void {
    this.refreshers.set(sessionId, onRestarted)
    return () => {
      if (this.refreshers.get(sessionId) === onRestarted) this.refreshers.delete(sessionId)
    }
  }

  restarted(sessionId: string): void {
    this.refreshers.get(sessionId)?.()
  }
}
