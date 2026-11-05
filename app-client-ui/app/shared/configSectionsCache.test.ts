import { describe, expect, it } from 'vitest'
import { ConfigSectionsCache } from './configSectionsCache'
import { UiSettings } from '../../shared/uiSettings'

describe('ConfigSectionsCache', () => {
  it('refuses reads before the owner provides its initial sections', () => {
    expect(() => new ConfigSectionsCache().read('ui')).toThrow('Configuration sections are not ready')
  })

  it('keeps owner and reader mutations outside its confirmed snapshot', () => {
    const value = { ui: UiSettings.defaultValue() }
    const cache = new ConfigSectionsCache()
    cache.update(value)
    value.ui.fontScalePercent = 150
    const read = cache.read('ui')
    read.fontScalePercent = 125
    expect(cache.read('ui').fontScalePercent).toBe(UiSettings.defaultValue().fontScalePercent)
  })

  it('changes only when the owner publishes another confirmed snapshot', () => {
    const cache = new ConfigSectionsCache()
    const value = { ui: UiSettings.defaultValue() }
    cache.update(value)
    const proposed = { ...value, ui: { ...value.ui, fontScalePercent: 125 } }
    expect(cache.read('ui')).toEqual(value.ui)
    cache.update(proposed)
    expect(cache.read('ui')).toEqual(proposed.ui)
  })
})
