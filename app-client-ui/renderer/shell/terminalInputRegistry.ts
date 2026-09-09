export interface TerminalInputTarget {
  writable(): boolean
  write(data: string): boolean
  focus(): void
}

export interface TerminalInputOptions {
  focus?: boolean
}

/**
 * Per renderer document, panels register the way into their own session's terminal, and synthetic
 * terminal commands read it.
 *
 * It is a document-local registry rather than a channel to the main process because input to a
 * session travels through the attach socket and nowhere else: a main-side path would need a second
 * attach per click, against a Host that allows 64 of them, or a Host operation of its own - both
 * real machinery duplicating a path that already exists and is already ownership-guarded. The active
 * tab of THIS window is by definition a panel of THIS document, in a holder window as much as in the
 * main one, so the target the button needs is always in the same document as the bar.
 *
 * The key is the SESSION, not the attach: what a caller knows about a tab is its session,
 * and the attach id is minted inside the panel once per run of its effect. That is also the first of
 * the three things that stop a write reaching the wrong session - the key is derived from the active
 * panel id in one act, the registered target is the very panel that attached that session and
 * refuses while its surface is not live, and the main process's ownership check on `terminal:input`
 * is the last gate under both.
 */
export class TerminalInputRegistry {
  private static readonly enterConst = '\r'
  // Codex treats Enter as pasted text until the synthetic command burst has settled.
  private static readonly enterDelayMillisecondsConst = 100

  private readonly targets = new Map<string, TerminalInputTarget>()

  /** The returned function retires THIS registration alone: a late unmount cannot delete a newer one. */
  register(sessionId: string, target: TerminalInputTarget): () => void {
    this.targets.set(sessionId, target)
    return () => {
      if (this.targets.get(sessionId) === target) this.targets.delete(sessionId)
    }
  }

  has(sessionId: string): boolean {
    return this.targets.get(sessionId)?.writable() === true
  }

  insert(sessionId: string, text: string, options: TerminalInputOptions = {}): boolean {
    const target = this.targets.get(sessionId)
    if (target === undefined || !target.writable()) return false
    if (options.focus !== false) target.focus()
    return target.write(text)
  }

  submit(sessionId: string, text: string, options: TerminalInputOptions = {}): boolean {
    const target = this.targets.get(sessionId)
    if (target === undefined) return false
    if (options.focus !== false) target.focus()
    if (!target.write(text)) return false
    setTimeout(() => {
      /*
       * The session's CURRENT way in, re-read rather than the object captured above. The panel
       * re-registers whenever its own send callback changes identity, and that callback is keyed on
       * the surface's status - so any frame inside this window, a reconnect or a read-only flip and
       * back, replaced the target and an identity guard dropped the Enter.
       *
       * Asking the map again is what the rule always meant: the text went to a SESSION, and the
       * Enter belongs to whatever is showing that session now. A panel that unmounted entirely
       * leaves nothing here and nothing is written, which is the case the guard was written for.
       */
      this.targets.get(sessionId)?.write(TerminalInputRegistry.enterConst)
    }, TerminalInputRegistry.enterDelayMillisecondsConst)
    return true
  }
}
