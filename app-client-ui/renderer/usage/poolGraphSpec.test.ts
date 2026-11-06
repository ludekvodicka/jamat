import { describe, expect, it } from 'vitest'
import { poolGraphSpec, poolReadout } from './poolGraphSpec'

const dateTime = (at: number) => {
  const date = new Date(at)
  return { year: date.getFullYear(), month: date.getMonth() + 1, date: date.getDate(), hours: date.getHours(),
    minutes: date.getMinutes(), seconds: date.getSeconds(), milliseconds: date.getMilliseconds() }
}

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
  it('labels the time axis with one date per day and no hours', () => {
    const spec = poolGraphSpec({ ...series, recorded: [{ at: 1, remaining: 90 }] }, theme)
    expect(spec && 'layer' in spec ? spec.layer[0] : null).toMatchObject({ encoding: { x: { title: null,
      axis: { format: '%a %d %b', tickCount: { interval: 'day', step: 1 } } } } })
  })
  it('fixes historical bounds and omits the projection and Now layers outside them', () => {
    const spec = poolGraphSpec({ ...series, now: 10, displayRange: { from: 2, to: 4 },
      recorded: [{ at: 1, remaining: 100 }, { at: 3, remaining: 90 }], projected: [{ at: 10, remaining: 70 }] }, theme)
    expect(spec).toMatchObject({ layer: [{ data: { values: [{ at: 3, remaining: 90 }] },
      mark: { type: 'line', clip: true }, encoding: { x: { scale: { domain: [dateTime(2), dateTime(4)] } } } }] })
  })
  it('shows a future-only projection without requiring recorded points in that range', () => {
    const spec = poolGraphSpec({ ...series, now: 1, displayRange: { from: 2, to: 4 },
      projected: [{ at: 2, remaining: 90 }, { at: 4, remaining: 70 }] }, theme)
    expect(spec).toMatchObject({ layer: [
      { mark: { type: 'line' }, data: { values: [] } },
      { mark: { type: 'line', strokeDash: [6, 4], clip: true }, encoding: { x: { scale: { domain: [dateTime(2), dateTime(4)] } } } },
    ] })
  })
  it('includes the Now rule when it is inside explicit display bounds', () => {
    const spec = poolGraphSpec({ ...series, displayRange: { from: 0, to: 2 },
      recorded: [{ at: 1, remaining: 90 }], projected: [{ at: 1, remaining: 90 }, { at: 2, remaining: 80 }] }, theme)
    expect(spec).toMatchObject({ layer: [{}, {}, { data: { values: [{ at: 1 }] }, mark: { type: 'rule', clip: true } }] })
  })
  it('draws to the edge of narrower bounds through the first projected point beyond them', () => {
    const spec = poolGraphSpec({ ...series, now: 1, displayRange: { from: 0, to: 100 },
      recorded: [{ at: 0, remaining: 100 }], projected: [{ at: 1, remaining: 90 }, { at: 5, remaining: 0 }, { at: 50, remaining: 0 }, { at: 50, remaining: 100 }] },
    theme, { from: 0, to: 10 })
    expect(spec).toMatchObject({ layer: [{}, { data: { values: [{ at: 1, remaining: 90 }, { at: 5, remaining: 0 }, { at: 50, remaining: 0 }] } }, {}] })
    expect(spec && 'layer' in spec ? spec.layer[0] : null).toMatchObject({ encoding: { x: { scale: { domain: [dateTime(0), dateTime(10)] } } } })
  })
  it('reads both lines at a moment by interpolating between their points', () => {
    const readout = poolReadout({ ...series, now: 2 * 3_600_000, recorded: [{ at: 0, remaining: 100 }, { at: 2 * 3_600_000, remaining: 80 }],
      projected: [{ at: 2 * 3_600_000, remaining: 80 }, { at: 12 * 3_600_000, remaining: 0 }] }, 3_600_000)
    expect(readout).toMatchObject({ detail: '1h ago', rows: [{ label: 'Recorded', value: '90.0%' }] })
    expect(poolReadout({ ...series, now: 0, projected: [{ at: 0, remaining: 80 }, { at: 10, remaining: 0 }] }, 5).rows)
      .toEqual([{ label: 'Projected', value: '40.0%' }])
  })
})
