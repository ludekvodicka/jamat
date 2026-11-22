import { accountWindows } from '../agentAccounts/defaultAccount'
import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
import { JsonShape } from '../shared/jsonShape'
import { JsonlRecords } from '../shared/jsonlRecords'
import { TranscriptTailReader } from '../shared/transcriptTailReader'
import type { LimitReading, LimitWindow } from './limitRecoveryApi.types'

export interface AntigravityLimitContext { cwd: string; nativeSessionId: string }

export interface AntigravityLimitTranscriptResolver {
  resolve(input: { agentId: 'antigravity'; cwd: string; nativeSessionId: string }): Promise<ProviderTranscriptRef | null>
}

/**
 * Detects whether an Antigravity CLI session stopped on a usage/quota limit.
 *
 * Inspects the tail of `transcript.jsonl` for an error step naming quota/rate-limit exhaustion, and
 * falls back to checking the live Antigravity primary rate windows (`100%` used) when the latest
 * turn ended with an error or did not complete.
 */
export class AntigravityLimitReader extends TranscriptTailReader<AntigravityLimitContext, LimitReading, ProviderTranscriptRef> {
  private static readonly tailBytesConst = 65_536
  private static readonly quotaErrorPatternConst = /\b(?:resource_exhausted|quota\s+(?:exceeded|exhausted|limit)|rate\s*limit(?:ed)?|usage\s+limit|too\s+many\s+requests|429)\b/i

  private readonly rates: () => readonly RateAccountState[]

  constructor(
    transcripts: AntigravityLimitTranscriptResolver,
    rates: () => readonly RateAccountState[] = () => [],
  ) {
    super((context) => transcripts.resolve({ agentId: 'antigravity', ...context }))
    this.rates = rates
  }

  read(context: AntigravityLimitContext): Promise<LimitReading> {
    return this.readTail(context)
  }

  static lastOf(content: string, rates: readonly RateAccountState[] = []): LimitReading {
    let last: Record<string, unknown> | null = null
    for (const raw of JsonlRecords.of(content)) {
      const record = JsonShape.record(raw)
      if (record === null) continue
      const type = record['type']
      if (type === 'USER_INPUT' || type === 'PLANNER_RESPONSE' || type === 'ERROR' || record['status'] === 'ERROR')
        last = record
    }
    if (last === null) return { kind: 'none' }
    const exhausted = AntigravityLimitReader.exhaustedWindowOf(rates)
    const isError = last['status'] === 'ERROR' || last['type'] === 'ERROR'
    const text = AntigravityLimitReader.textOf(last)
    if (isError && text !== null && AntigravityLimitReader.quotaErrorPatternConst.test(text)) {
      const step = typeof last['step_index'] === 'number' ? last['step_index'] : 0
      const at = typeof last['created_at'] === 'string' ? Date.parse(last['created_at']) : NaN
      return {
        kind: 'limit',
        recordId: `antigravity-step-${step}`,
        at: Number.isFinite(at) ? at : 0,
        window: exhausted?.window ?? AntigravityLimitReader.windowFromText(text),
        resetsAt: exhausted?.resetsAt ?? null,
      }
    }
    // If a user sent a prompt and the primary quota window is simultaneously exhausted with no
    // completed planner answer afterwards, treat it as a quota stop tied to the window reset time.
    if (exhausted !== null && (last['type'] === 'USER_INPUT' || isError)) {
      const step = typeof last['step_index'] === 'number' ? last['step_index'] : 0
      const at = typeof last['created_at'] === 'string' ? Date.parse(last['created_at']) : NaN
      return {
        kind: 'limit',
        recordId: `antigravity-quota-${step}-${exhausted.resetsAt ?? 'unknown'}`,
        at: Number.isFinite(at) ? at : 0,
        window: exhausted.window,
        resetsAt: exhausted.resetsAt,
      }
    }
    return { kind: 'none' }
  }

  private static exhaustedWindowOf(
    rates: readonly RateAccountState[],
  ): { window: LimitWindow; resetsAt: number | null } | null {
    const rate = rates.find((candidate) => candidate.key.agentId === 'antigravity' && candidate.key.accountId === 'main')
    let match: { window: LimitWindow; resetsAt: number | null } | null = null
    for (const window of accountWindows(rate)) {
      if (window.model !== undefined || window.usedPercent < 100) continue
      if (window.durationMinutes !== 300 && window.durationMinutes !== 10_080) continue
      const parsed = window.resetsAt === null ? null : Date.parse(window.resetsAt)
      const resetsAt = parsed !== null && Number.isFinite(parsed) ? parsed : null
      const kind: LimitWindow = window.durationMinutes === 300 ? 'session' : 'weekly'
      if (match === null || (resetsAt !== null && (match.resetsAt === null || resetsAt > match.resetsAt)))
        match = { window: kind, resetsAt }
    }
    return match
  }

  private static windowFromText(text: string): LimitWindow {
    if (/weekly|7[- ]?day/i.test(text)) return 'weekly'
    if (/5[- ]?hour|session/i.test(text)) return 'session'
    return 'other'
  }

  private static textOf(record: Record<string, unknown>): string | null {
    const parts: string[] = []
    for (const key of ['error', 'message', 'content'])
      if (typeof record[key] === 'string' && record[key]!.trim().length > 0) parts.push(record[key]!)
    return parts.length > 0 ? parts.join('\n') : null
  }

  protected missing(): LimitReading {
    return { kind: 'none' }
  }

  protected async saltOf(): Promise<string> {
    const exhausted = AntigravityLimitReader.exhaustedWindowOf(this.rates())
    return exhausted === null ? '' : `${exhausted.window}:${exhausted.resetsAt ?? ''}`
  }

  protected async readFrom(ref: ProviderTranscriptRef): Promise<LimitReading> {
    const tail = await TranscriptTailReader.file(ref, AntigravityLimitReader.tailBytesConst)
    return AntigravityLimitReader.lastOf(tail.content, this.rates())
  }
}
