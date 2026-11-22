import { describe, expect, it } from 'vitest'
import { AccountBrokerAnswers } from './accountBrokerAnswer'

describe('AccountBrokerAnswers', () => {
  it('reads the per-model counters of a Claude result and ignores its other members', () => {
    const result = { type: 'result', usage: { input_tokens: 2 }, modelUsage: {
      'claude-opus-5-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 649, cacheCreationInputTokens: 3_249, costUSD: 0.1 },
      'claude-haiku-5-5': { inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }
    expect(AccountBrokerAnswers.usageModels(result)).toEqual({
      'claude-opus-5-5': { input: 2, output: 4, cacheRead: 649, cacheWrite: 3_249 },
      'claude-haiku-5-5': { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } })
  })

  it('reads no usage from a result without models, with a broken counter or with a model name that needs quoting', () => {
    const counters = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 }
    for (const result of [null, [], {}, { modelUsage: {} }, { modelUsage: { m: { ...counters, outputTokens: -1 } } },
      { modelUsage: { m: { ...counters, inputTokens: 1.5 } } }, { modelUsage: { m: { ...counters, cacheReadInputTokens: '3' } } },
      { modelUsage: { 'a b': counters } }, { modelUsage: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`m${index}`, counters])) }])
      expect(AccountBrokerAnswers.usageModels(result)).toBeNull()
  })

  it('accepts a report command that is a string and refuses any other', () => {
    expect(AccountBrokerAnswers.is({ ...AccountBrokerAnswers.main('chosen'), reportCommand: 'node x accounts report' })).toBe(true)
    expect(AccountBrokerAnswers.is({ ...AccountBrokerAnswers.main('chosen'), reportCommand: 7 })).toBe(false)
  })

  it('accepts a version 1 answer with members it does not know', () => {
    expect(AccountBrokerAnswers.is({ ...AccountBrokerAnswers.main('chosen'), later: { any: 1 } })).toBe(true)
    expect(AccountBrokerAnswers.is({ ...AccountBrokerAnswers.main('timeout'), reason: 'a-later-reason' })).toBe(true)
  })

  it('refuses another version, a missing unset list and a set value that is no string', () => {
    const answer = AccountBrokerAnswers.main('chosen')
    expect(AccountBrokerAnswers.is({ ...answer, brokerVersion: 2 })).toBe(false)
    expect(AccountBrokerAnswers.is({ ...answer, env: { set: {} } })).toBe(false)
    expect(AccountBrokerAnswers.is({ ...answer, env: { set: { CLAUDE_CONFIG_DIR: 1 }, unset: [] } })).toBe(false)
    expect(AccountBrokerAnswers.is({ ...answer, reuseSeconds: -1 })).toBe(false)
    expect(AccountBrokerAnswers.is(null)).toBe(false)
  })

  it('removes the home variable for Main, or sets the orchestrator home when it has one', () => {
    expect(AccountBrokerAnswers.mainEnv(null)).toEqual({ set: {}, unset: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] })
    expect(AccountBrokerAnswers.mainEnv('C:/home/main')).toEqual({ set: { CLAUDE_CONFIG_DIR: 'C:/home/main' }, unset: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] })
  })

  it('marks every Main answer other than a choice as a short-lived fallback', () => {
    expect(AccountBrokerAnswers.main('chosen')).toMatchObject({ fallback: false, reason: 'chosen', reuseSeconds: 300 })
    expect(AccountBrokerAnswers.main('jamat-unavailable')).toMatchObject({ fallback: true, reuseSeconds: 60,
      account: { id: 'main', label: 'Main', identityKey: null, tier: null } })
  })
})
