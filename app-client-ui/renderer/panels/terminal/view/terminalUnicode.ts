import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Terminal } from '@xterm/xterm'

/**
 * How wide a character is, decided once for every terminal this client opens.
 *
 * xterm ships the Unicode 6 table, in which an emoji is one cell wide. Every agent, every shell and
 * the Windows console measure it at two, so a line carrying one ends a cell short of the right edge:
 * the first character of the next line is pulled onto its tail, and from there a box-drawn frame
 * walks one column further left with every emoji it contains. Nothing repairs it until a resize
 * makes the agent repaint - which is why toggling the sidebar looked like the fix.
 *
 * The same version is registered on the Host's projection. Both sides have to agree: the snapshot an
 * attach is served is serialized out of that buffer and written into this one, so a table registered
 * on one side alone moves the damage rather than removing it.
 */
export class TerminalUnicode {
  private static readonly versionConst = '11'

  static apply(terminal: Terminal): void {
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = TerminalUnicode.versionConst
  }
}
