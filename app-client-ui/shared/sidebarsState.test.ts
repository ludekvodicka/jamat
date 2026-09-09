import { describe, expect, it } from 'vitest'

import { SidebarsState } from './sidebarsState'

describe('app-client-ui/shared/sidebarsState', () => {
  it('opens the left side and leaves the right one closed by default', () => {
    const state = SidebarsState.default()
    expect(state.left.visible).toBe(true)
    expect(state.right.visible).toBe(false)
    expect(state.left.activeView).toBeNull()
  })

  it('coerces anything that is not a document to the default', () => {
    for (const value of [null, undefined, 'left', 42, []])
      expect(SidebarsState.coerce(value)).toEqual(SidebarsState.default())
  })

  it('keeps the readable half of a half-broken document', () => {
    const state = SidebarsState.coerce({
      left: { visible: false, width: 'wide', activeView: 7 },
      right: { visible: true, width: 300, activeView: 'probeRight' },
    })
    expect(state.left.visible).toBe(false)
    expect(state.left.width).toBe(SidebarsState.default().left.width)
    expect(state.left.activeView).toBeNull()
    expect(state.right).toEqual({ visible: true, width: 300, activeView: 'probeRight' })
  })

  it('clamps a width to the allowed range and rounds it', () => {
    expect(SidebarsState.clamp(10)).toBe(SidebarsState.minWidthConst)
    expect(SidebarsState.clamp(10_000)).toBe(SidebarsState.maxWidthConst)
    expect(SidebarsState.clamp(240.6)).toBe(241)
    expect(SidebarsState.clamp(Number.NaN)).toBe(SidebarsState.default().left.width)
  })

  it('clamps through withWidth as well, so no caller can store an unclamped width', () => {
    const state = SidebarsState.withWidth(SidebarsState.default(), 'right', 5)
    expect(state.right.width).toBe(SidebarsState.minWidthConst)
    expect(state.left).toEqual(SidebarsState.default().left)
  })

  it('toggles one side and leaves the other alone', () => {
    const once = SidebarsState.toggled(SidebarsState.default(), 'left')
    expect(once.left.visible).toBe(false)
    expect(once.right).toEqual(SidebarsState.default().right)
    expect(SidebarsState.toggled(once, 'left').left.visible).toBe(true)
  })

  it('replaces a view key nobody registered with the first known one', () => {
    const stored = SidebarsState.coerce({
      left: { visible: true, width: 200, activeView: 'goneInV2' },
      right: { visible: true, width: 200, activeView: 'probeRight' },
    })
    const state = SidebarsState.withKnownViews(stored, (side) =>
      side === 'left' ? ['probeLeft'] : ['probeRight'])
    expect(state.left.activeView).toBe('probeLeft')
    expect(state.right.activeView).toBe('probeRight')
  })

  it('leaves a side with no registered view holding null rather than a made-up key', () => {
    const state = SidebarsState.withKnownViews(SidebarsState.default(), () => [])
    expect(state.left.activeView).toBeNull()
    expect(state.right.activeView).toBeNull()
  })
})
