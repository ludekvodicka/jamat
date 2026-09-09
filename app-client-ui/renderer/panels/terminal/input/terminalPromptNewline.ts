import type { SessionInfo } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

export type TerminalAgentId = NonNullable<SessionInfo['agent']>['agentId']

/**
 * `Shift+Enter` puts a line into an agent's prompt instead of submitting it.
 *
 * A terminal has no such key. Enter is CR and every modifier of it is the same CR, so an agent can
 * only tell the two apart if the terminal spells the modified one differently - and what it must
 * spell differs per agent, because each reads a different encoding. Claude accepts the CSI-u form of
 * Shift+Enter; Codex has no such key at all and takes its own newline, `Ctrl+J`, as a bare LF.
 *
 * The sequences are V1's, and **what decides between its two forms is ConPTY, not this terminal.**
 * These bytes are written straight to the PTY, so they never pass through xterm's key encoding at
 * all; what reads them is conhost, which asks for win32 input mode on its own (`CSI ?9001h` is in
 * every session's stream) and understands those records whether or not the terminal answered. A
 * `Shift+Enter` measured through the real Host, ConPTY and a child reporting its console records:
 *
 * | written | delivered as |
 * |---|---|
 * | `CR` | `Enter` |
 * | `LF` | `Enter`+`Ctrl`, NOT `Ctrl+J` |
 * | `ESC [ 13 ; 2 u` | no record at all; passed through to a child that reads bytes |
 * | `ESC [ 74 ; 36 ; 10 ; 1 ; 8 ; 1 _` | `J`+`Ctrl` |
 *
 * That is the whole of why the two agents differ. Claude is a Node process reading bytes, so the
 * CSI-u form reaches it as itself. Codex is a Rust TUI reading console records, so a bare LF reaches
 * it as `Ctrl+Enter` and its newline key never fires; the win32 input record is the only spelling
 * that arrives as the `Ctrl+J` it binds.
 *
 * **Registered trigger (`CLAUDE.md` rule 4):** the Codex form is ConPTY's. A platform without it
 * delivers a bare LF as the line feed it is, and Codex's newline there is `'\n'` again.
 */
export class TerminalPromptNewline {
  /** Claude reads `ESC [ 13 ; 2 u`: the CSI-u spelling of Enter with the shift modifier. */
  private static readonly claudeSequenceConst = '\x1b[13;2u'
  /** Codex binds its prompt newline to `Ctrl+J`, as a win32 input record: `KeyJ` + `LeftCtrl`. */
  private static readonly codexSequenceConst = '\x1b[74;36;10;1;8;1_'

  /** Whether these bytes are one of the two sequences above rather than characters somebody typed. */
  static isSequence(data: string): boolean {
    return data === TerminalPromptNewline.claudeSequenceConst
      || data === TerminalPromptNewline.codexSequenceConst
  }

  /**
   * The bytes this keystroke stands for, or null for one that is not the prompt newline - including
   * every keystroke in a session with no agent behind it, where Shift+Enter is the shell's own Enter
   * and submitting the line is what it is for.
   */
  static sequenceOf(event: KeyboardEvent, agentId: TerminalAgentId | null): string | null {
    if (event.type !== 'keydown' || event.key !== 'Enter' || !event.shiftKey) return null
    // Ctrl+Shift+Enter and its like are somebody else's key, and not one this may answer for.
    if (event.ctrlKey || event.altKey || event.metaKey) return null
    if (agentId === null) return null
    else if (agentId === 'claude') return TerminalPromptNewline.claudeSequenceConst
    else if (agentId === 'codex') return TerminalPromptNewline.codexSequenceConst
    else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }
}
