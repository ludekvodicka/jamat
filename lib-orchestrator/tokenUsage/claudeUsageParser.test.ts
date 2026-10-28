import { describe, expect, it } from 'vitest'
import { ClaudeUsageParser } from './claudeUsageParser'

describe('ClaudeUsageParser', () => {
  it('retains the global message/request identity and all non-overlapping counters', () => {
    const state = ClaudeUsageParser.source('unused').initial('session.jsonl')
    const record = ClaudeUsageParser.parse(JSON.stringify({ type: 'assistant', timestamp: '2026-10-26T12:00:00Z', requestId: 'request',
      cwd: 'Q:/Projects/A', message: { id: 'message', model: 'opus', usage: {
        input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
      } } }), state)
    expect(record).toMatchObject({ dedupe: '["message","request"]', input: 10, output: 5, cacheRead: 20, cacheWrite: 30, cwd: 'Q:/Projects/A' })
  })
  it('ignores malformed/incomplete rows and does not deduplicate missing identities', () => {
    const state = ClaudeUsageParser.source('unused').initial('session.jsonl')
    expect(ClaudeUsageParser.parse('{', state)).toBeNull()
    expect(ClaudeUsageParser.parse(JSON.stringify({ type: 'assistant', timestamp: '2026-10-26', message: { usage: {} } }), state)?.dedupe).toBeNull()
  })
})
