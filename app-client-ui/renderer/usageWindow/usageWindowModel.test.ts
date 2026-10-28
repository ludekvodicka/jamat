import { describe, expect, it } from 'vitest'
import { UsageWindowModel } from './usageWindowModel'

describe('UsageWindowModel', () => {
  it('labels estimates with the age of the original reading', () => {
    expect(UsageWindowModel.measurement({ key: { agentId: 'claude', accountId: 'main' }, label: 'Main',
      enabled: true, accountState: 'active', source: 'poll', state: { kind: 'never-read' },
      estimated: { estimated: true, windows: [], sampleAt: 1, ageMilliseconds: 7_200_000 } })).toBe('estimate from 2h ago')
  })
})
