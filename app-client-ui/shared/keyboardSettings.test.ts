import { describe, expect, it } from 'vitest'

import { AppCommands } from './commands'
import { KeyboardSettings } from './keyboardSettings'

describe('app-client-ui/shared/keyboardSettings', () => {
  it('defaults to what the catalog itself declares', () => {
    expect(KeyboardSettings.defaultConst.launcherKeys)
      .toBe(AppCommands.launcherKeyDefaultConst)
    expect(KeyboardSettings.preferencesConst[0]).toBe(AppCommands.launcherKeyDefaultConst)
  })

  /*
   * Both rows spell the WHOLE pair out. Either one read alone has to answer what Ctrl+T does and
   * what Ctrl+Shift+T does, because the two keys are one decision and a row naming only its own
   * half would leave the other key looking unassigned.
   */
  it('describes both keys in each answer, and names the same two keys in both', () => {
    const sessionFirst = KeyboardSettings.describe('session-first')
    const tabFirst = KeyboardSettings.describe('tab-first')

    expect(sessionFirst.note).toContain('Ctrl+T opens New Session')
    expect(sessionFirst.note).toContain('Ctrl+Shift+T opens New Tab')
    expect(tabFirst.note).toContain('Ctrl+T opens New Tab')
    expect(tabFirst.note).toContain('Ctrl+Shift+T opens New Session')
    expect(sessionFirst.title).not.toBe(tabFirst.title)
  })

  it('throws on a preference it does not know', () => {
    expect(() => KeyboardSettings.describe('ctrl-p' as never))
      .toThrow(/Unknown launcher key preference/)
  })

  it('reads anything it cannot use as the default, and says so once', () => {
    const messages: string[] = []
    const report = (message: string): void => { messages.push(message) }

    expect(KeyboardSettings.coerce({ launcherKeys: 'tab-first' }, report))
      .toEqual({ launcherKeys: 'tab-first' })
    expect(KeyboardSettings.coerce(undefined, report)).toEqual(KeyboardSettings.defaultConst)
    expect(KeyboardSettings.coerce({}, report)).toEqual(KeyboardSettings.defaultConst)
    // Neither of those two is a complaint: an absent section and an absent field are how a config
    // that has never been written reads, and reporting them would report the ordinary case.
    expect(messages).toEqual([])

    expect(KeyboardSettings.coerce({ launcherKeys: 7 }, report))
      .toEqual(KeyboardSettings.defaultConst)
    expect(messages).toHaveLength(1)
  })

  it('validates exactly what it can coerce to', () => {
    expect(KeyboardSettings.isValid({ launcherKeys: 'session-first' })).toBe(true)
    expect(KeyboardSettings.isValid({ launcherKeys: 'tab-first' })).toBe(true)
    expect(KeyboardSettings.isValid({ launcherKeys: 'ctrl-p' as never })).toBe(false)
  })
})
