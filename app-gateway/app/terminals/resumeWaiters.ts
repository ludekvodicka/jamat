/**
 * Attaches that arrived while a window's output was truncated. The owner releases them after its
 * own resume, so a waiter checks the owner's paused state again: another truncation can come first.
 */
export class ResumeWaiters {
  private readonly waiters: Set<{ resolve(): void; reject(error: Error): void }>
  private closed: boolean

  constructor() {
    this.waiters = new Set()
    this.closed = false
  }

  wait(signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) return Promise.reject(new Error('Terminal attach was cancelled'))
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.waiters.delete(waiter); reject(new Error('Terminal attach was cancelled')) }
      const waiter = {
        resolve: () => { signal.removeEventListener('abort', abort); resolve() },
        reject: (error: Error) => { signal.removeEventListener('abort', abort); reject(error) },
      }
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.add(waiter)
    })
  }

  release(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const waiter of waiters) waiter.resolve()
  }

  close(): void {
    this.closed = true
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const waiter of waiters) waiter.reject(new Error('Window terminal connection is closed'))
  }
}
