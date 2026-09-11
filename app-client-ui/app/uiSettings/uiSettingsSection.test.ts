import { describe, expect, it } from 'vitest'

import { UiSettings } from '../../shared/uiSettings'
import { UiSettingsSection } from './uiSettingsSection'

describe('app-client-ui/app/uiSettings/uiSettingsSection', () => {
  // The one thing in this file nothing else can catch: the wrong key reads and writes another
  // section of the same document, and every test above this one would still pass.
  it('owns the ui key of config.json', () => {
    expect(UiSettingsSection.spec.key).toBe('ui')
  })

  it('lets a value the controls can produce through, and refuses one they cannot', () => {
    expect(UiSettingsSection.spec.validate(UiSettings.defaultValue())).toBeNull()
    expect(UiSettingsSection.spec.validate({
      ...UiSettings.defaultValue(),
      fontScalePercent: 112,
    })).toContain('multiples of')
    // The scroll speeds have a step of their own, and a value off THAT grid is refused by the same
    // validator: 110 is a font scale the controls can produce and a scroll speed they cannot.
    expect(UiSettingsSection.spec.validate({
      ...UiSettings.defaultValue(),
      scrollSpeedPercent: 110,
    })).toContain('multiples of')
    expect(UiSettingsSection.spec.validate({
      ...UiSettings.defaultValue(),
      terminalTheme: 'powershell' as never,
    })).toContain('terminalTheme')
  })

  it('reads a damaged section as the defaults rather than throwing', () => {
    const messages: string[] = []
    expect(UiSettingsSection.spec.coerce(5, (message) => messages.push(message)))
      .toEqual(UiSettings.defaultValue())
    expect(messages).toHaveLength(1)
  })
})
