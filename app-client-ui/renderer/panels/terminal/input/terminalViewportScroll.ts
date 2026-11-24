export type TerminalBufferType = 'normal' | 'alternate'

/**
 * Keyboard paging over xterm's own scrollback (`Shift+PageUp` / `Shift+PageDown`).
 *
 * xterm forwards bare and modified `PageUp`/`PageDown` to the PTY rather than scrolling its
 * viewport, which works for full-screen TUIs on the alternate screen (Claude Code, Codex) that
 * scroll themselves, but leaves normal-buffer agents (such as Antigravity) with no keyboard scroll.
 * Only `Shift+PageUp`/`Shift+PageDown` on the normal buffer are intercepted here so applications on
 * either buffer keep bare `PageUp`/`PageDown` and alternate-screen TUIs keep every modified form.
 */
export class TerminalViewportScroll {
  static pagesOf(event: KeyboardEvent, bufferType: TerminalBufferType): -1 | 1 | null {
    if (event.type !== 'keydown') return null
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null
    if (bufferType === 'alternate') return null
    else if (bufferType !== 'normal')
      throw new Error(`Unknown terminal buffer type: ${JSON.stringify(bufferType satisfies never)}`)
    if (event.key === 'PageUp') return -1
    if (event.key === 'PageDown') return 1
    return null
  }
}
