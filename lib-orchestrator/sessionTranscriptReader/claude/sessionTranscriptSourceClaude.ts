import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { TranscriptTailReader, type TranscriptTailContent } from '../../shared/transcriptTailReader'
import type {
  SessionTranscriptMessage,
  SessionTranscriptReading,
} from '../sessionTranscriptReaderApi.types'
import type { SessionTranscriptLimits } from '../sessionTranscriptSource'
import { SessionTranscriptSource } from '../sessionTranscriptSource'

export class SessionTranscriptSourceClaude extends SessionTranscriptSource {
  private static readonly firstPassBytesConst = 262_144
  private static readonly secondPassBytesConst = 1_048_576

  readonly agentId = 'claude' as const

  async read(
    ref: ProviderTranscriptRef,
    limits: SessionTranscriptLimits,
  ): Promise<SessionTranscriptReading> {
    let found: SessionTranscriptMessage[]
    let tail: TranscriptTailContent
    try {
      tail = await TranscriptTailReader.file(
        ref,
        SessionTranscriptSourceClaude.firstPassBytesConst,
      )
      found = SessionTranscriptSourceClaude.scan(
        tail.content,
      )
      // One tool result can be larger than the whole first pass, so a session that said plenty can
      // still show almost nothing in it. Widening on a short answer is the ordinary case here.
      if (found.length < limits.maxMessages
        && ref.size > SessionTranscriptSourceClaude.firstPassBytesConst) {
          tail = await TranscriptTailReader.file(
            ref,
            SessionTranscriptSourceClaude.secondPassBytesConst,
          )
          found = SessionTranscriptSourceClaude.scan(tail.content)
        }
    }
    catch (error) {
      return {
        kind: 'none',
        code: 'transcript-unreadable',
        reason: `transcript unreadable: ${ErrorText.of(error)}`,
      }
    }
    if (found.length === 0)
      return {
        kind: 'none',
        code: 'no-messages-in-scanned-tail',
        reason: 'nothing was said in the scanned transcript tail',
      }
    return {
      kind: 'messages',
      messages: SessionTranscriptSource.tail(found, limits),
      bounds: {
        maxMessages: limits.maxMessages,
        maxCharactersPerMessage: limits.maxCharactersPerMessage,
        scannedBytes: tail.scannedBytes,
      },
      earlierContentOmitted: !tail.startedAtFileBeginning || found.length > limits.maxMessages,
    }
  }

  /**
   * Forward, because the tail is retold in the order it was written.
   *
   * A sidechain is a sub-agent talking to itself and a meta record is Claude Code talking to itself;
   * both are written as ordinary user turns and neither was said in this conversation.
   */
  private static scan(content: string): SessionTranscriptMessage[] {
    const messages: SessionTranscriptMessage[] = []
    for (const raw of JsonlRecords.of(content)) {
      const record = JsonShape.record(raw)
      if (record === null) continue
      if (record['isMeta'] === true || record['isSidechain'] === true) continue
      const role = SessionTranscriptSource.role(record['type'])
      if (role === null) continue
      const body = JsonShape.record(record['message'])?.['content']
      let text: string | null
      if (role === 'user') text = SessionTranscriptSourceClaude.userTextOf(body)
      else if (role === 'assistant') text = SessionTranscriptSourceClaude.assistantTextOf(body)
      else
        throw new Error(`Unknown transcript role: ${JSON.stringify(role)}`)
      if (text === null) continue
      messages.push({
        role,
        text,
        at: SessionTranscriptSource.writtenAt(record['timestamp']),
        textTruncated: false,
      })
    }
    return messages
  }

  /**
   * A tool result comes back as a user turn, and so do the command wrappers and the reminders Claude
   * Code injects - all of them opening with a tag. None of it is what the person typed.
   */
  private static userTextOf(content: unknown): string | null {
    if (Array.isArray(content)
      && content.some((block) => JsonShape.record(block)?.['type'] === 'tool_result'))
      return null
    const text = typeof content === 'string'
      ? content.trim()
      : SessionTranscriptSourceClaude.textBlocksOf(content)
    return text.length > 0 && !text.startsWith('<') ? text : null
  }

  /** A turn that only called tools carries no text block, and is not a thing that was said. */
  private static assistantTextOf(content: unknown): string | null {
    const text = SessionTranscriptSourceClaude.textBlocksOf(content)
    return text.length > 0 ? text : null
  }

  private static textBlocksOf(content: unknown): string {
    if (!Array.isArray(content)) return ''
    return content
      .flatMap((raw) => {
        const block = JsonShape.record(raw)
        const text = block?.['type'] === 'text' ? block['text'] : null
        return typeof text === 'string' ? [text] : []
      })
      .join('\n')
      .trim()
  }
}
