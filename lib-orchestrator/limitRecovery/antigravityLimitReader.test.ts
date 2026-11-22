import { describe, expect, it } from 'vitest'

import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
import { AntigravityLimitReader } from './antigravityLimitReader'

describe('lib-orchestrator/limitRecovery/antigravityLimitReader', () => {
  const exhaustedRate: RateAccountState = {
    key: { agentId: 'antigravity', accountId: 'main' },
    label: 'Main',
    source: 'statusline',
    estimated: null,
    state: {
      kind: 'ok',
      fetchedAt: Date.parse('2026-11-21T20:00:00Z'),
      windows: [
        { durationMinutes: 300, usedPercent: 100, resetsAt: '2026-11-21T22:00:00Z' },
        { durationMinutes: 10_080, usedPercent: 15, resetsAt: '2026-11-28T00:00:00Z' },
      ],
    },
  }

  it('detects quota exhaustion error steps and pairs them with live Antigravity reset time', () => {
    const content = [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-21T20:00:00Z', content: 'continue' }),
      JSON.stringify({ step_index: 2, type: 'ERROR', status: 'ERROR', created_at: '2026-11-21T20:00:01Z', error: 'RESOURCE_EXHAUSTED: 5-hour quota exceeded' }),
    ].join('\n')
    expect(AntigravityLimitReader.lastOf(content, [exhaustedRate])).toEqual({
      kind: 'limit',
      recordId: 'antigravity-step-2',
      at: Date.parse('2026-11-21T20:00:01Z'),
      window: 'session',
      resetsAt: Date.parse('2026-11-21T22:00:00Z'),
    })
  })

  it('returns none after a completed planner response even when quota is at 100%', () => {
    const content = [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-21T20:00:00Z', content: 'hi' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T20:00:02Z', content: 'Done.' }),
    ].join('\n')
    expect(AntigravityLimitReader.lastOf(content, [exhaustedRate])).toEqual({ kind: 'none' })
  })

  it('detects an unanswered user turn when primary Antigravity quota window is 100% used', () => {
    const content = JSON.stringify({
      step_index: 5,
      type: 'USER_INPUT',
      created_at: '2026-11-21T20:00:00Z',
      content: 'keep going',
    })
    expect(AntigravityLimitReader.lastOf(content, [exhaustedRate])).toEqual({
      kind: 'limit',
      recordId: `antigravity-quota-5-${Date.parse('2026-11-21T22:00:00Z')}`,
      at: Date.parse('2026-11-21T20:00:00Z'),
      window: 'session',
      resetsAt: Date.parse('2026-11-21T22:00:00Z'),
    })
  })
})
