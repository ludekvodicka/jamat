import { describe, expect, it } from 'vitest'

import { KeyboardSettings } from '../../shared/keyboardSettings'
import { KeyboardSettingsSection } from './keyboardSettingsSection'

describe('app-client-ui/app/keyboardSettings/keyboardSettingsSection', () => {
  // The one thing in this file nothing else can catch: the wrong key reads and writes another
  // section of the same document, and every test above this one would still pass.
  it('owns the keyboard key of config.json', () => {
    expect(KeyboardSettingsSection.spec.key).toBe('keyboard')
  })

  it('lets both answers the tab can produce through, and refuses one it cannot', () => {
    expect(KeyboardSettingsSection.spec.validate({ launcherKeys: 'session-first' })).toBeNull()
    expect(KeyboardSettingsSection.spec.validate({ launcherKeys: 'tab-first' })).toBeNull()
    expect(KeyboardSettingsSection.spec.validate({ launcherKeys: 'ctrl-p' as never }))
      .toContain('launcherKeys')
  })

  it('reads a damaged section as the default rather than throwing', () => {
    const messages: string[] = []
    expect(KeyboardSettingsSection.spec.coerce(5, (message) => messages.push(message)))
      .toEqual(KeyboardSettings.defaultConst)
    expect(messages).toHaveLength(1)
  })

  /*
   * A file written by hand carries whatever else somebody put beside the key. The read answers the
   * default for the field it does not recognise and says so once, rather than refusing the section.
   */
  it('keeps its own field only, and reports an unreadable one', () => {
    const messages: string[] = []
    expect(KeyboardSettingsSection.spec.coerce(
      { launcherKeys: 'tab-first', note: 'set on the laptop' },
      (message) => messages.push(message),
    )).toEqual({ launcherKeys: 'tab-first' })
    expect(messages).toEqual([])

    expect(KeyboardSettingsSection.spec.coerce(
      { launcherKeys: 'nonsense' },
      (message) => messages.push(message),
    )).toEqual(KeyboardSettings.defaultConst)
    expect(messages).toHaveLength(1)
  })
})
