import { describe, expect, it } from 'vitest'
import { poolGraphSpec } from './poolGraphSpec'

describe('poolGraphSpec', () => {
  const theme = { text: 'text', grid: 'grid', accent: 'accent' }
  const series = { recorded: [], projected: [], now: 1, until: 2, burnPerHour: 0, poolEmptyAt: null,
    firstEmpty: null, nextReset: null, knownAccounts: 0, totalAccounts: 1 }
  it('returns an empty state without samples', () => { expect(poolGraphSpec(series, theme)).toBeNull() })
  it('draws a solid recorded line, dashed projection and Now rule', () => {
    const spec = poolGraphSpec({ ...series, recorded: [{ at: 1, remaining: 90 }] }, theme)
    expect(spec).toMatchObject({ layer: [
      { mark: { type: 'line', color: 'accent' } },
      { mark: { type: 'line', strokeDash: [6, 4] } },
      { mark: { type: 'rule' }, data: { values: [{ at: 1 }] } },
    ] })
  })
  it('fixes historical bounds and omits the projection and Now layers outside them', () => {
    const spec = poolGraphSpec({ ...series, now: 10, displayRange: { from: 2, to: 4 },
      recorded: [{ at: 1, remaining: 100 }, { at: 3, remaining: 90 }], projected: [{ at: 10, remaining: 70 }] }, theme)
    expect(spec).toMatchObject({ layer: [{ data: { values: [{ at: 3, remaining: 90 }] },
      mark: { type: 'line', clip: true }, encoding: { x: { scale: { domain: [2, 4] } } } }] })
  })
  it('shows a future-only projection without requiring recorded points in that range', () => {
    const spec = poolGraphSpec({ ...series, now: 1, displayRange: { from: 2, to: 4 },
      projected: [{ at: 2, remaining: 90 }, { at: 4, remaining: 70 }] }, theme)
    expect(spec).toMatchObject({ layer: [
      { mark: { type: 'line' }, data: { values: [] } },
      { mark: { type: 'line', strokeDash: [6, 4], clip: true }, encoding: { x: { scale: { domain: [2, 4] } } } },
    ] })
  })
  it('includes the Now rule when it is inside explicit display bounds', () => {
    const spec = poolGraphSpec({ ...series, displayRange: { from: 0, to: 2 },
      recorded: [{ at: 1, remaining: 90 }], projected: [{ at: 1, remaining: 90 }, { at: 2, remaining: 80 }] }, theme)
    expect(spec).toMatchObject({ layer: [{}, {}, { data: { values: [{ at: 1 }] }, mark: { type: 'rule', clip: true } }] })
  })
})
