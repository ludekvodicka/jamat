import { describe, expect, it } from 'vitest'
import { HistoricSessionsModel } from './historicSessionsModel'

describe('app-client-ui/renderer/overlays/launcher/history/historicSessionsModel', () => {
  it.each([
    ['1d', '2026-09-12T14:30:00Z'],
    ['2d', '2026-09-11T14:30:00Z'],
    ['7d', '2026-09-06T14:30:00Z'],
    ['1m', '2026-08-14T14:30:00Z'],
    ['all', null],
  ] as const)('uses a rolling last-use cutoff for %s', (range, expected) => {
    expect(HistoricSessionsModel.lastUsedSince(range, Date.parse('2026-09-13T14:30:00Z')))
      .toBe(expected === null ? null : Date.parse(expected))
  })
})
