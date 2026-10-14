import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { UiSettings } from '../../shared/uiSettings'
import { UiSettingsSection } from './uiSettingsSection'

describe('app-client-ui/app/uiSettings/uiSettingsSection', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('loads an old ui section and removes the retired key on save without losing other fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pp-u6-ui-settings-'))
    created.push(directory)
    const configFile = join(directory, 'config.json')
    const original = JSON.stringify({
      schemaVersion: 1,
      ui: { sessionsScriptRuns: true, fontScalePercent: 115, sessionsNestWorktrees: false, _later: { mode: 'all' } },
      _README: 'Keep this note',
      categories: ['nodejs'],
    })
    writeFileSync(configFile, original, 'utf8')
    const messages: string[] = []
    const options = { snapshotsDirectory: join(directory, 'snapshots'), report: (message: string) => messages.push(message) }
    const store = ConfigStore.load(directory, options)
    const value = store.readSection(UiSettingsSection.spec)

    expect(value).not.toHaveProperty('sessionsScriptRuns')
    expect(value).toMatchObject({ fontScalePercent: 115, sessionsNestWorktrees: false, _later: { mode: 'all' } })
    expect(readFileSync(configFile, 'utf8')).toBe(original)
    expect(store.saveSection(UiSettingsSection.spec, value)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      ui: { ...UiSettings.defaultValue(), fontScalePercent: 115, sessionsNestWorktrees: false, _later: { mode: 'all' } },
      _README: 'Keep this note',
      categories: ['nodejs'],
    })
    expect(ConfigStore.load(directory, options).readSection(UiSettingsSection.spec)).toEqual(value)
    expect(messages).toEqual([])
  })

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
