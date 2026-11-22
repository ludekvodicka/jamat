import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import { TranscriptTailReader, type TranscriptTailContent } from '../../shared/transcriptTailReader'
import type {
  SessionTranscriptMessage,
  SessionTranscriptReading,
} from '../sessionTranscriptReaderApi.types'
import type { SessionTranscriptLimits } from '../sessionTranscriptSource'
import { SessionTranscriptSource } from '../sessionTranscriptSource'

/**
 * Reads user and assistant turns out of an Antigravity CLI compact transcript
 * (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`).
 */
export class SessionTranscriptSourceAntigravity extends SessionTranscriptSource {
  private static readonly firstPassBytesConst = 262_144
  private static readonly secondPassBytesConst = 1_048_576
  private static readonly userRequestTagConst = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/

  readonly agentId = 'antigravity' as const

  async read(
    ref: ProviderTranscriptRef,
    limits: SessionTranscriptLimits,
  ): Promise<SessionTranscriptReading> {
    let found: SessionTranscriptMessage[]
    let tail: TranscriptTailContent
    try {
      tail = await TranscriptTailReader.file(
        ref,
        SessionTranscriptSourceAntigravity.firstPassBytesConst,
      )
      found = SessionTranscriptSourceAntigravity.scan(tail.content)
      if (found.length < limits.maxMessages
        && ref.size > SessionTranscriptSourceAntigravity.firstPassBytesConst) {
        tail = await TranscriptTailReader.file(
          ref,
          SessionTranscriptSourceAntigravity.secondPassBytesConst,
        )
        found = SessionTranscriptSourceAntigravity.scan(tail.content)
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

  static extractUserText(content: unknown): string | null {
    if (typeof content !== 'string') return null
    const tagged = SessionTranscriptSourceAntigravity.userRequestTagConst.exec(content)
    const text = (tagged !== null ? tagged[1]! : content).trim()
    return text.length > 0 ? text : null
  }

  private static scan(content: string): SessionTranscriptMessage[] {
    const messages: SessionTranscriptMessage[] = []
    for (const raw of JsonlRecords.of(content)) {
      const record = JsonShape.record(raw)
      if (record === null) continue
      const type = record['type']
      if (type === 'USER_INPUT' && record['source'] === 'USER_EXPLICIT') {
        const text = SessionTranscriptSourceAntigravity.extractUserText(record['content'])
        if (text !== null)
          messages.push({
            role: 'user',
            text,
            at: SessionTranscriptSource.writtenAt(record['created_at']),
            textTruncated: false,
          })
      }
      else if (type === 'PLANNER_RESPONSE') {
        const text = typeof record['content'] === 'string' ? record['content'].trim() : ''
        if (text.length > 0)
          messages.push({
            role: 'assistant',
            text,
            at: SessionTranscriptSource.writtenAt(record['created_at']),
            textTruncated: false,
          })
      }
    }
    return messages
  }
}
