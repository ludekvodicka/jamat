import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RemoteControlSettings } from '../../shared/remoteControlSettings'
import { RemoteControlSettingsSection } from './remoteControlSettingsSection'

describe('app-client-ui/app/remoteControl/remoteControlSettingsSection', () => {
  it('owns the remoteControl key and protects damaged hand edits', () => {
    expect(RemoteControlSettingsSection.spec.key).toBe('remoteControl')
    expect(RemoteControlSettingsSection.spec.validate(RemoteControlSettings.defaultValue())).toBeNull()
    expect(RemoteControlSettingsSection.spec.damaged?.(undefined)).toBe(false)
    expect(RemoteControlSettingsSection.spec.damaged?.({ listener: true })).toBe(true)
  })

  /**
   * The template somebody copies, read off disk and put through the section that will read the copy,
   * with the one edit copying it is FOR.
   *
   * `remoteControl.listener` named only `enabled` and `bindHost` until 2026-08-31, and all four keys
   * are required, so every copy of that example was a DAMAGED section the moment its listener was
   * switched on: `coerce` fell back to the default, the listener came up disabled, and the screen
   * looked exactly like one nobody had ever turned on. The file is READ here rather than written out
   * again, because a second copy of the example inside this test would pass while the shipped one
   * stayed broken - which is the whole failure this guards.
   */
  it('reads the shipped config.example.json with its listener switched on', () => {
    const example = JSON.parse(readFileSync(
      new URL('../../../configs/config.example.json', import.meta.url),
      'utf8',
    )) as { remoteControl?: { listener?: Record<string, unknown> } }
    const shipped = example.remoteControl
    // Without this the example could stop naming the section at all and everything below would pass
    // over nothing.
    expect(shipped?.listener).toBeDefined()
    expect(Object.keys(shipped?.listener ?? {}).sort())
      .toEqual(['advertisedHost', 'bindHost', 'enabled', 'port'])
    expect(RemoteControlSettingsSection.spec.damaged?.(shipped)).toBe(false)

    const listening = { ...shipped, listener: { ...shipped?.listener, enabled: true } }
    const messages: string[] = []
    const coerced = RemoteControlSettingsSection.spec.coerce(
      listening,
      (message) => messages.push(message),
    )

    expect(messages).toEqual([])
    expect(RemoteControlSettingsSection.spec.damaged?.(listening)).toBe(false)
    expect(RemoteControlSettingsSection.spec.validate(coerced)).toBeNull()
    // The fallback is a DISABLED listener carrying the section's own defaults, so this is the one
    // assertion a damaged example cannot pass however closely its other values match.
    expect(coerced.listener).toEqual({ ...listening.listener, enabled: true })
    expect(coerced.listener.enabled).toBe(true)
  })
})
