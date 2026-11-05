import { describe, expect, it } from 'vitest'
import type { SessionInfo } from './sessionManagerApi.types'
import { SessionPromptInsert } from './sessionPromptInsert'

describe('SessionPromptInsert', () => {
  const live = { life: 'live', agent: { agentId: 'claude' }, activity: 'idle' } as const

  it.each(['idle', 'working', 'unknown'] as const)('accepts live agents with %s activity', (activity) => {
    for (const agentId of ['claude', 'codex'] as const)
      expect(SessionPromptInsert.refusal({ ...live, agent: { agentId }, activity })).toBeNull()
  })

  it('refuses a permission or choice wait', () => {
    expect(SessionPromptInsert.refusal({ ...live, activity: 'waiting' })).toBe('agent-waiting')
  })

  it.each(['starting', 'ended', 'lost'] as const)('refuses %s sessions', (life) => {
    expect(SessionPromptInsert.refusal({ ...live, life })).toBe('not-live')
  })

  it('refuses sessions without an agent or agent activity', () => {
    expect(SessionPromptInsert.refusal({ ...live, agent: undefined })).toBe('no-agent')
    expect(SessionPromptInsert.refusal({ ...live, activity: null })).toBe('no-agent')
  })

  it('throws for unknown activity and life values', () => {
    expect(() => SessionPromptInsert.refusal({ ...live, activity: 'future' as SessionInfo['activity'] })).toThrow('Unknown session activity')
    expect(() => SessionPromptInsert.refusal({ ...live, life: 'future' as SessionInfo['life'] })).toThrow('Unknown session life')
  })
})
