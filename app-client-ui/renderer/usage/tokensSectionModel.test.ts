import { describe, expect, it } from 'vitest'
import { TokensSectionModel } from './tokensSectionModel'

describe('TokensSectionModel', () => {
  it('totals each non-overlapping counter once', () => {
    expect(TokensSectionModel.total({ input: 70, cacheRead: 30, output: 20, cacheWrite: 0 })).toBe(120)
  })
  it('sums the counters of every row', () => {
    expect(TokensSectionModel.sum([{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }]))
      .toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 })
  })
  it('reads one bar: its total, each agent when there are two, then the counters', () => {
    const row = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }
    const rows = [{ ...row, key: '14', label: '14:00', agentId: 'claude' as const }, { ...row, key: '14', label: '14:00', agentId: 'codex' as const },
      { ...row, key: '15', label: '15:00', agentId: 'claude' as const }]
    expect(TokensSectionModel.readout(rows, '14:00')).toEqual({ title: '14:00', rows: [{ label: 'Total', value: '3.0k' },
      { label: 'Claude', value: '1.5k' }, { label: 'Codex', value: '1.5k' }, { label: 'Input', value: '2.0k' }, { label: 'Output', value: '1.0k' },
      { label: 'Cache read', value: '0' }, { label: 'Cache write', value: '0' }] })
    expect(TokensSectionModel.readout(rows, '15:00')?.rows.map(item => item.label)).toEqual(['Total', 'Input', 'Output', 'Cache read', 'Cache write'])
    expect(TokensSectionModel.readout(rows, '16:00')).toBeNull()
  })
})
