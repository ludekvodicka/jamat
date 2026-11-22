import { basename, dirname } from 'node:path'

import { AntigravityConfigHome } from '../shared/antigravityConfigHome'
import type { TokenAccountResolver } from './tokenUsageSource'
import { usageJson, usageNumber, type TokenUsageSource, type UsageParserState, type UsageRecord } from './tokenUsageSource'

/**
 * Parses Antigravity CLI transcripts (`<home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`)
 * into token usage records.
 */
export class AntigravityUsageParser {
  static accountResolver(): TokenAccountResolver {
    return () => 'main'
  }

  static source(home: string): TokenUsageSource {
    return {
      agentId: 'antigravity',
      root: AntigravityConfigHome.brainDirectory(home),
      accepts: (name) => name === 'transcript.jsonl',
      initial: (file) => ({
        nativeId: AntigravityUsageParser.conversationIdOf(file),
        cwd: '',
        model: 'unknown',
        rolloutAccount: null,
        cumulative: null,
      }),
      parse: AntigravityUsageParser.parse,
    }
  }

  static parse(line: string, state: UsageParserState): UsageRecord | null {
    const row = usageJson(line)
    if (!row || row['type'] !== 'PLANNER_RESPONSE') return null
    const at = typeof row['created_at'] === 'string' ? Date.parse(row['created_at']) : NaN
    if (!Number.isFinite(at)) return null
    const model = typeof row['model'] === 'string' && row['model'].length > 0 ? row['model'] : state.model
    state.model = model
    const input = usageNumber(row['input_tokens'])
    const output = usageNumber(row['output_tokens'])
    const cacheRead = usageNumber(row['cache_read_tokens'])
    if (input === 0 && output === 0 && cacheRead === 0) return null
    const stepIndex = typeof row['step_index'] === 'number' && Number.isSafeInteger(row['step_index'])
      ? row['step_index'] : null
    return {
      at,
      nativeId: state.nativeId,
      cwd: state.cwd,
      model,
      rolloutAccount: null,
      dedupe: stepIndex === null ? null : `${state.nativeId}:${stepIndex}`,
      input,
      output,
      cacheRead,
      cacheWrite: 0,
    }
  }

  /** `<root>/<conversationId>/.system_generated/logs/transcript.jsonl` -> `<conversationId>`. */
  private static conversationIdOf(file: string): string {
    const logs = dirname(file)
    const systemGenerated = dirname(logs)
    const conversation = dirname(systemGenerated)
    return basename(conversation) || basename(file, '.jsonl')
  }
}
