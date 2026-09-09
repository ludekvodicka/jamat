/**
 * What the status bar draws about the session behind the active terminal. The renderer compiles this
 * file, so it has no imports at all and never grows one.
 */

export type SessionModelAgentId = 'claude' | 'codex'

export interface SessionModelInfo {
  model: string
  modelLabel: string
  /**
   * Claude: the project's configured effort, read from the settings cascade, not the live state of
   * the running agent. Codex: read back out of the running session's own `turn_context`.
   */
  effortLevel: string | null
  contextTokens: number
  /**
   * null = the model is not in the window table. V1 answered 0 here and the caller hid the whole
   * widget, so a new model family silently blanked the line; here the model and the tokens are still
   * drawn and only the window and the percentage are left out.
   *
   * For Claude the million-token tier comes from the same settings cascade the effort does, because
   * the transcript records the bare id the API answered with and never the tier.
   */
  contextWindow: number | null
}

export type SessionModelReading =
  | { kind: 'ok'; info: SessionModelInfo }
  | { kind: 'none'; reason: string }
