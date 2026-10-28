import type { TokenAgentId, TokenCounts } from './tokenUsageApi.types'
export type TokenAccountResolver = (nativeId: string, at: number, rolloutAccount: string | null) => string

export interface UsageRecord extends TokenCounts {
  at: number
  nativeId: string
  cwd: string
  model: string
  rolloutAccount: string | null
  dedupe: string | null
}

export interface UsageParserState {
  nativeId: string
  cwd: string
  model: string
  rolloutAccount: string | null
  cumulative: { input: number; output: number; cached: number } | null
}

export interface TokenUsageSource {
  agentId: TokenAgentId
  root: string
  accepts(name: string): boolean
  initial(file: string): UsageParserState
  parse(line: string, state: UsageParserState): UsageRecord | null
}

export function usageJson(line: string): Record<string, unknown> | null {
  try { return usageObject(JSON.parse(line)) } catch { return null }
}
export function usageObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
