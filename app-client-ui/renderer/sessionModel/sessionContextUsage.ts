import type { SessionModelInfo } from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'

export class SessionContextUsage {
  private static readonly staleAfterMillisecondsConst = 40_000
  private static readonly thousandConst = 1_000
  private static readonly millionConst = 1_000_000
  private static readonly groupingLocaleConst = 'en-US'

  static percentOf(info: SessionModelInfo): number | null {
    if (!Number.isFinite(info.contextTokens) || info.contextTokens < 0)
      return null
    if (info.contextWindow === null
      || !Number.isFinite(info.contextWindow)
      || info.contextWindow <= 0)
      return null
    return Math.round((info.contextTokens / info.contextWindow) * 100)
  }

  static isStale(age: number): boolean {
    return age >= SessionContextUsage.staleAfterMillisecondsConst
  }

  static freshMillisecondsRemaining(age: number): number {
    return Math.max(0, SessionContextUsage.staleAfterMillisecondsConst - age)
  }

  static shortTokens(tokens: number): string {
    if (tokens >= SessionContextUsage.millionConst) {
      const millions = tokens / SessionContextUsage.millionConst
      return `${millions.toFixed(tokens % SessionContextUsage.millionConst === 0 ? 0 : 1)}M`
    }
    if (tokens >= SessionContextUsage.thousandConst)
      return `${Math.round(tokens / SessionContextUsage.thousandConst)}k`
    return String(tokens)
  }

  static exactTokens(tokens: number): string {
    return tokens.toLocaleString(SessionContextUsage.groupingLocaleConst)
  }
}
