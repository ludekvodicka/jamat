/**
 * The last words of a session, drawn by the post-mortem block of a panel whose runtime is gone. The
 * renderer compiles this file, so it has no imports at all and never grows one.
 */

export type SessionTranscriptAgentId = 'claude' | 'codex'

export interface SessionTranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  /** Epoch ms of the record that carried it; null when no readable timestamp was written. */
  at: number | null
  textTruncated: boolean
}

export type SessionTranscriptNoneCode =
  | 'not-agent'
  | 'native-session-id-pending'
  | 'transcript-not-found'
  | 'no-messages-in-scanned-tail'
  | 'transcript-unreadable'

export interface SessionTranscriptBounds {
  maxMessages: number
  maxCharactersPerMessage: number
  scannedBytes: number
}

export type SessionTranscriptReading =
  | {
    kind: 'messages'
    messages: readonly SessionTranscriptMessage[]
    bounds: SessionTranscriptBounds
    earlierContentOmitted: boolean
  }
  | { kind: 'none'; code: SessionTranscriptNoneCode; reason: string }
