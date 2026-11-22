import { describe, expect, it } from 'vitest'
import { TokensSectionModel } from './tokensSectionModel'

describe('TokensSectionModel', () => {
  const theme = { text: 't', grid: 'g', accent: 'a', series: ['s1', 's2', 's3'] }

  it('totals each non-overlapping counter once', () => {
    expect(TokensSectionModel.total({ input: 70, cacheRead: 30, output: 20, cacheWrite: 0 })).toBe(120)
  })
  it('sums the counters of every row', () => {
    expect(TokensSectionModel.sum([{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }]))
      .toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 })
  })
  it('reads one bar: its total, each agent when there are several with theme colors, then the counters', () => {
    const row = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }
    const rows = [
      { ...row, key: '14', label: '14:00', agentId: 'claude' as const },
      { ...row, key: '14', label: '14:00', agentId: 'codex' as const },
      { ...row, key: '14', label: '14:00', agentId: 'antigravity' as const },
      { ...row, key: '15', label: '15:00', agentId: 'claude' as const },
    ]
    expect(TokensSectionModel.readout(rows, '14:00', theme)).toEqual({ title: '14:00', rows: [
      { label: 'Total', value: '4.5k' },
      { label: 'Claude', value: '1.5k', color: 's1' },
      { label: 'Codex', value: '1.5k', color: 's2' },
      { label: 'Antigravity', value: '1.5k', color: 's3' },
      { label: 'Input', value: '3.0k' }, { label: 'Output', value: '1.5k' },
      { label: 'Cache read', value: '0' }, { label: 'Cache write', value: '0' },
    ] })
    expect(TokensSectionModel.readout(rows, '15:00')?.rows.map(item => item.label)).toEqual(['Total', 'Input', 'Output', 'Cache read', 'Cache write'])
    expect(TokensSectionModel.readout(rows, '16:00')).toBeNull()
  })
  it('color-encodes each agent separately in the bar chart spec', () => {
    const spec = TokensSectionModel.chart([
      { key: '2026-11-21', label: '2026-11-21', agentId: 'antigravity', input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    ], theme) as { encoding: { color: { field: string; scale: { domain: string[]; range: string[] } } } }
    expect(spec.encoding.color.field).toBe('agentId')
    expect(spec.encoding.color.scale).toEqual({ domain: ['claude', 'codex', 'antigravity'], range: ['s1', 's2', 's3'] })
  })
})
