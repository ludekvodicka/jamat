import { describe, expect, it } from 'vitest'
import { AccountBrokerAnswers } from './accountBrokerAnswer'

describe('AccountBrokerAnswers', () => {
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
