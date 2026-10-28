import { describe, expect, it } from 'vitest'
import { CodexUsageParser } from './codexUsageParser'

describe('CodexUsageParser', () => {
  it('uses cumulative deltas, ignores duplicates, uses last-call on first/reset and counts overlap once', () => {
    const state = CodexUsageParser.source('unused').initial('rollout-x.jsonl')
    const event = (input: number, output: number, cached: number, last?: number) => JSON.stringify({
      timestamp: '2026-10-26T12:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: 5 },
        ...(last === undefined ? {} : { last_token_usage: { input_tokens: last, output_tokens: 2, cached_input_tokens: 3 } }),
      } },
    })
    expect(CodexUsageParser.parse(event(100, 20, 30, 10), state)).toMatchObject({ input: 7, output: 2, cacheRead: 3, cacheWrite: 0 })
    expect(CodexUsageParser.parse(event(150, 30, 50), state)).toMatchObject({ input: 30, output: 10, cacheRead: 20 })
    expect(CodexUsageParser.parse(event(150, 30, 50), state)).toBeNull()
    expect(CodexUsageParser.parse(event(20, 5, 4, 8), state)).toMatchObject({ input: 5, output: 2, cacheRead: 3 })
    expect(CodexUsageParser.parse(event(1, 1, 9), state)).toMatchObject({ input: 0, output: 1, cacheRead: 1 })
  })
  it('counts last-only events and retains the cumulative baseline for the following total', () => {
    const state = CodexUsageParser.source('unused').initial('rollout-x.jsonl')
    const event = (info: object) => JSON.stringify({ timestamp: '2026-10-26T12:00:00Z', type: 'event_msg',
      payload: { type: 'token_count', info } })
    const last = { input_tokens: 20, cached_input_tokens: 6, output_tokens: 8, reasoning_output_tokens: 3 }
    expect(CodexUsageParser.parse(event({ last_token_usage: last }), state)).toMatchObject({ input: 14, cacheRead: 6, output: 8, cacheWrite: 0 })
    expect(state.cumulative).toBeNull()
    expect(CodexUsageParser.parse(event({ total_token_usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 40 } }), state))
      .toMatchObject({ input: 70, cacheRead: 30, output: 40 })
    expect(CodexUsageParser.parse(event({ last_token_usage: last }), state)).toMatchObject({ input: 14, cacheRead: 6, output: 8 })
    expect(state.cumulative).toEqual({ input: 100, cached: 30, output: 40 })
    expect(CodexUsageParser.parse(event({ total_token_usage: { input_tokens: 150, cached_input_tokens: 45, output_tokens: 60 } }), state))
      .toMatchObject({ input: 35, cacheRead: 15, output: 20 })
    expect(CodexUsageParser.parse(event({}), state)).toBeNull()
    expect(state.cumulative).toEqual({ input: 150, cached: 45, output: 60 })
  })
})
