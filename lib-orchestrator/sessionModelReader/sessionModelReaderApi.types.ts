/**
 * What the status bar draws about the session behind the active terminal. The renderer compiles this
 * file, so it has no imports at all and never grows one.
 */

export type SessionModelAgentId = 'claude' | 'codex'

export interface SessionModelInfo {
  model: string
  modelLabel: string
  /**
   * Claude: the effort recorded on the last real turn of the transcript; the settings cascade only
   * when the transcript records none. Codex: read back out of the running session's own `turn_context`.
   */
  effortLevel: string | null
  contextTokens: number
  /**
   * null = the model is not in the window table. V1 answered 0 here and the caller hid the whole
   * widget, so a new model family silently blanked the line; here the model and the tokens are still
   * drawn and only the window and the percentage are left out.
   *
   * For Claude it is the window Claude Code handed its status line, stored by Jamat's relay; where
   * no snapshot exists it is guessed from the id, the launch and the settings cascade, because the
   * transcript records the bare id the API answered with and never the tier.
   */
  contextWindow: number | null
}

export type SessionModelReading =
  | { kind: 'ok'; info: SessionModelInfo }
  | { kind: 'none'; reason: string }
