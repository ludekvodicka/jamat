import { AppCommands, type LauncherKeyPreference } from './commands'

/**
 * What the `keyboard` section of `config.json` holds. One field, and deliberately one: this is a
 * swap between two fixed keys, not a key editor, so there is nothing here for a second field to say.
 */
export interface KeyboardSettingsValue {
  launcherKeys: LauncherKeyPreference
}

export type KeyboardSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

/**
 * The rules of the launcher key pair, with no React, no DOM and no imports outside the command
 * catalog: this file compiles into the node program and the web one alike, which is what lets the
 * main process build its menu and the settings tab draw its two rows from one list.
 *
 * Reads are lenient and writes are strict, the asymmetry every store in this tree uses: anything
 * unreadable reads as the catalog's own default, while a save carrying it is refused, because
 * coercing a write would store something other than what was asked for.
 */
export class KeyboardSettings {
  /** In the order the tab offers them, the default first. */
  static readonly preferencesConst: readonly LauncherKeyPreference[] =
    ['session-first', 'tab-first']

  static readonly defaultConst: KeyboardSettingsValue = {
    launcherKeys: AppCommands.launcherKeyDefaultConst,
  }

  static coerce(
    value: unknown,
    report: (problem: string) => void,
  ): KeyboardSettingsValue {
    if (typeof value !== 'object' || value === null) {
      if (value !== undefined) report('keyboard is not an object')
      return { ...KeyboardSettings.defaultConst }
    }
    const launcherKeys = (value as { launcherKeys?: unknown }).launcherKeys
    if (KeyboardSettings.isPreference(launcherKeys)) return { launcherKeys }
    if (launcherKeys !== undefined)
      report(`keyboard.launcherKeys is not one of ${KeyboardSettings.preferencesConst.join(', ')}`)
    return { ...KeyboardSettings.defaultConst }
  }

  static isValid(value: KeyboardSettingsValue): boolean {
    return KeyboardSettings.isPreference(value.launcherKeys)
  }

  /** What the two rows say: the pair, spelled out, so neither row has to be read to be understood. */
  static describe(preference: LauncherKeyPreference): { title: string; note: string } {
    if (preference === 'session-first')
      return {
        title: 'New Session',
        note: 'Ctrl+T opens New Session, Ctrl+Shift+T opens New Tab',
      }
    else if (preference === 'tab-first')
      return {
        title: 'New Tab',
        note: 'Ctrl+T opens New Tab, Ctrl+Shift+T opens New Session',
      }
    else
      throw new Error(`Unknown launcher key preference: ${JSON.stringify(preference)}`)
  }

  private static isPreference(value: unknown): value is LauncherKeyPreference {
    return KeyboardSettings.preferencesConst.includes(value as LauncherKeyPreference)
  }
}
