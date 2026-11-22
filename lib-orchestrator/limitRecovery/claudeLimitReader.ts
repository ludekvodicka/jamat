import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import { JsonShape } from '../shared/jsonShape'
import { JsonlRecords } from '../shared/jsonlRecords'
import { TranscriptTailReader } from '../shared/transcriptTailReader'
import type { LimitReading, LimitWindow } from './limitRecoveryApi.types'

export interface ClaudeLimitContext { cwd: string; nativeSessionId: string }

export interface ClaudeLimitTranscriptResolver {
  resolve(input: { agentId: 'claude'; cwd: string; nativeSessionId: string }): Promise<ProviderTranscriptRef | null>
}

/**
 * Whether a Claude session's last turn is a refused request on a usage limit. Claude Code writes that
 * refusal as a synthetic assistant record with `apiError: "usage_limit_reached"` and the limit's type
 * and reset in `apiErrorParams.rate_limit_info`; the shape is Claude Code's, not a published contract.
 */
export class ClaudeLimitReader extends TranscriptTailReader<ClaudeLimitContext, LimitReading, ProviderTranscriptRef> {
  private static readonly tailBytesConst = 65_536

  constructor(transcripts: ClaudeLimitTranscriptResolver) {
    super((context) => transcripts.resolve({ agentId: 'claude', ...context }))
  }

  read(context: ClaudeLimitContext): Promise<LimitReading> {
    return this.readTail(context)
  }

  /** The last user or assistant record of the main conversation decides; a newer user turn ends the limit. */
  static lastOf(content: string): LimitReading {
    let last: Record<string, unknown> | null = null
    for (const raw of JsonlRecords.of(content)) {
      const record = JsonShape.record(raw)
      if (record === null || record['isSidechain'] === true) continue
      if (record['type'] === 'user' || record['type'] === 'assistant') last = record
    }
    if (last === null || last['type'] !== 'assistant') return { kind: 'none' }
    const limited = last['apiError'] === 'usage_limit_reached'
      || (last['isApiErrorMessage'] === true && last['error'] === 'rate_limit')
    const recordId = last['uuid']
    if (!limited || typeof recordId !== 'string') return { kind: 'none' }
    const params = JsonShape.record(last['apiErrorParams'])
    const info = JsonShape.record(params?.['rate_limit_info']) ?? JsonShape.record(last['quotaLimits'])
    const at = typeof last['timestamp'] === 'string' ? Date.parse(last['timestamp']) : NaN
    const resetsAt = info?.['resetsAt']
    return {
      kind: 'limit',
      recordId,
      at: Number.isFinite(at) ? at : 0,
      window: ClaudeLimitReader.windowOf(info?.['rateLimitType']),
      resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1_000 : null,
    }
  }

  private static windowOf(type: unknown): LimitWindow {
    if (type === 'five_hour') return 'session'
    if (typeof type === 'string' && type.startsWith('seven_day')) return 'weekly'
    return 'other'
  }

  protected missing(): LimitReading {
    return { kind: 'none' }
  }

  protected async saltOf(): Promise<string> {
    return ''
  }

  protected async readFrom(ref: ProviderTranscriptRef): Promise<LimitReading> {
    const tail = await TranscriptTailReader.file(ref, ClaudeLimitReader.tailBytesConst)
    return ClaudeLimitReader.lastOf(tail.content)
  }
}
