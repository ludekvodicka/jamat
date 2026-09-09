import { describe, expect, it } from 'vitest'

import { DebugTimeFormat } from './debugTimeFormat'

describe('app-client-ui/renderer/debugWindow/sections/debugTimeFormat', () => {
  it('answers a missing time with a dash rather than an epoch', () => {
    expect(DebugTimeFormat.at(null)).toBe('—')
    expect(DebugTimeFormat.at(1_770_000_000_000))
      .toBe(new Date(1_770_000_000_000).toLocaleTimeString())
  })

  // Two units at every size: the tier below the largest is the one that says how close the next is.
  it('spells a length as the two units that matter at its size', () => {
    expect(DebugTimeFormat.duration(0)).toBe('0s')
    expect(DebugTimeFormat.duration(42_000)).toBe('42s')
    expect(DebugTimeFormat.duration(90_000)).toBe('1m 30s')
    expect(DebugTimeFormat.duration(3 * 3_600_000 + 15 * 60_000)).toBe('3h 15m')
    expect(DebugTimeFormat.duration(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h')
  })
})
