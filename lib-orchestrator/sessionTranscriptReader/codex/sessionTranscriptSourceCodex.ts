import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import { ProviderTranscriptMessages } from '../../projectManager/providerTranscriptMessages'
import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { TranscriptTailReader, type TranscriptTailContent } from '../../shared/transcriptTailReader'
import type {
  SessionTranscriptMessage,
  SessionTranscriptReading,
} from '../sessionTranscriptReaderApi.types'
import type { SessionTranscriptLimits } from '../sessionTranscriptSource'
import { SessionTranscriptSource } from '../sessionTranscriptSource'

export class SessionTranscriptSourceCodex extends SessionTranscriptSource {
  private static readonly tailBytesConst = 524_288
  /**
   * The ceiling on the second, wider pass. It is deliberately small: this runs on the client's main
   * thread, where the read, the split and one `JSON.parse` per line block the window, the Host socket
   * and every IPC handler for as long as they take. Four megabytes is several times the tail and
   * still bounded; a session whose last four megabytes are one blob shows what fits rather than
   * freezing the client to find the rest.
   */
  private static readonly maxReadBytesConst = 4 * 1_048_576

  readonly agentId = 'codex' as const

  async read(
    ref: ProviderTranscriptRef,
    limits: SessionTranscriptLimits,
  ): Promise<SessionTranscriptReading> {
    let found: SessionTranscriptMessage[]
    let tail: TranscriptTailContent
    try {
      tail = await TranscriptTailReader.file(ref, SessionTranscriptSourceCodex.tailBytesConst)
      found = SessionTranscriptSourceCodex.scan(
        tail.content,
      )
      // One patch or one tool output can be larger than the whole tail, so a session that said
      // plenty can still show almost nothing in it. Once, with a ceiling.
      if (found.length < limits.maxMessages
        && ref.size > SessionTranscriptSourceCodex.tailBytesConst) {
          tail = await TranscriptTailReader.file(
            ref,
            SessionTranscriptSourceCodex.maxReadBytesConst,
          )
          found = SessionTranscriptSourceCodex.scan(tail.content)
        }
    }
    catch (error) {
      return {
        kind: 'none',
        code: 'transcript-unreadable',
        reason: `rollout unreadable: ${ErrorText.of(error)}`,
      }
    }
    if (found.length === 0)
      return {
        kind: 'none',
        code: 'no-messages-in-scanned-tail',
        reason: 'nothing was said in the scanned rollout tail',
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
   * Only the `response_item` messages, because those are the turns as the model was handed them and
   * each of them is written exactly once. Codex repeats the same words as `event_msg` records for
   * its own display, and reading both would say everything twice.
   */
  private static scan(content: string): SessionTranscriptMessage[] {
    const messages: SessionTranscriptMessage[] = []
    for (const raw of JsonlRecords.of(content)) {
      const record = JsonShape.record(raw)
      const payload = JsonShape.record(record?.['payload'])
      if (record === null || payload === null) continue
      if (record['type'] !== 'response_item' || payload['type'] !== 'message') continue
      const role = SessionTranscriptSource.role(payload['role'])
      if (role === null) continue
      let text: string | null
      if (role === 'user') text = SessionTranscriptSourceCodex.typedTextOf(raw)
      else if (role === 'assistant') text = SessionTranscriptSourceCodex.contentTextOf(payload['content'])
      else
        throw new Error(`Unknown rollout role: ${JSON.stringify(role)}`)
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
   * The environment and the instructions Codex injects arrive as ordinary user turns; which ones
   * they are is the project manager's rule already, and one rule read by both readers is one rule.
   * Reached only for a `response_item` user message, so the answer is that message or nothing.
   */
  private static typedTextOf(raw: unknown): string | null {
    return ProviderTranscriptMessages.codex(raw)?.text ?? null
  }

  private static contentTextOf(content: unknown): string | null {
    if (!Array.isArray(content)) return null
    const text = content
      .flatMap((raw) => {
        const part = JsonShape.record(raw)?.['text']
        return typeof part === 'string' ? [part] : []
      })
      .join('')
      .trim()
    return text.length > 0 ? text : null
  }
}
