import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import type {
  SessionTranscriptAgentId,
  SessionTranscriptMessage,
  SessionTranscriptReading,
} from './sessionTranscriptReaderApi.types'

/** How much of a transcript is worth showing; the reader owns the numbers, a source applies them. */
export interface SessionTranscriptLimits {
  maxMessages: number
  maxCharactersPerMessage: number
}

/**
 * One provider's way of finding what was said in its own transcript.
 *
 * A source never throws: a transcript is a file another program wrote and may still be writing, so a
 * half record, a shape that changed under us and a session that said nothing at all are ordinary
 * endings, and each of them comes back as a `none` carrying its reason.
 */
export abstract class SessionTranscriptSource {
  abstract readonly agentId: SessionTranscriptAgentId

  abstract read(
    ref: ProviderTranscriptRef,
    limits: SessionTranscriptLimits,
  ): Promise<SessionTranscriptReading>

  protected static role(value: unknown): SessionTranscriptMessage['role'] | null {
    if (value === 'user') return 'user'
    else if (value === 'assistant') return 'assistant'
    else return null
  }

  protected static writtenAt(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const at = Date.parse(value)
    return Number.isFinite(at) ? at : null
  }

  /** The last messages allowed, retaining whether each original text was longer. */
  protected static tail(
    messages: readonly SessionTranscriptMessage[],
    limits: SessionTranscriptLimits,
  ): SessionTranscriptMessage[] {
    return messages
      .slice(Math.max(0, messages.length - limits.maxMessages))
      .map((message) => message.text.length <= limits.maxCharactersPerMessage
        ? message
        : {
          ...message,
          text: message.text.slice(0, limits.maxCharactersPerMessage),
          textTruncated: true,
        })
  }
}
