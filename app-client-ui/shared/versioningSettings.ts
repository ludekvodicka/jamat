import type { VersioningMode } from '../../lib-orchestrator/git/git.types'

/**
 * Which repository AI work goes into, as one client-owned setting.
 *
 * `VersioningMode` is imported rather than restated. The union already exists twice by necessity -
 * once in the library and once in `commit-git.sh`, which cannot import anything - and a third copy
 * here would be the one that drifts silently, because a renderer that offers a mode the library
 * does not know still compiles.
 *
 * It is deliberately GLOBAL rather than per project. Every machine here runs on the shared
 * instructions, which describe `checkpoints` and nothing else; the switch exists for somebody
 * running AppJamatV3 without them, and that is a property of the person, not of one project.
 */
export interface VersioningSettingsValue {
  mode: VersioningMode
}

export type VersioningSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

export class VersioningSettings {
  static readonly modeOptionsConst: readonly VersioningMode[] = ['checkpoints', 'git']
  static readonly defaultModeConst: VersioningMode = 'checkpoints'

  static defaultValue(): VersioningSettingsValue {
    return { mode: VersioningSettings.defaultModeConst }
  }

  /**
   * Reading is total: an absent section, a damaged one and an unusable mode all answer with the
   * default, because refusing to read leaves the app with no mode at all. What the user is told
   * apart is the difference between "you never set this" and "what is written cannot be used".
   */
  static coerce(value: unknown, report: (message: string) => void): VersioningSettingsValue {
    if (value === undefined) return VersioningSettings.defaultValue()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      report('The versioning section of config.json is not an object; reading mode as checkpoints')
      return VersioningSettings.defaultValue()
    }
    const document = value as Partial<Record<keyof VersioningSettingsValue, unknown>>
    if (VersioningSettings.isMode(document.mode))
      return { ...document, mode: document.mode }
    if (document.mode !== undefined)
      report(
        'The versioning section of config.json has an unusable mode '
        + `(${JSON.stringify(document.mode)}); reading it as checkpoints`,
      )
    return { ...document, mode: VersioningSettings.defaultModeConst }
  }

  /** Writing is strict, which is what keeps the file readable by the next version that reads it. */
  static isValid(value: unknown): value is VersioningSettingsValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const document = value as Partial<Record<keyof VersioningSettingsValue, unknown>>
    return VersioningSettings.isMode(document.mode)
  }

  private static isMode(value: unknown): value is VersioningMode {
    return typeof value === 'string'
      && (VersioningSettings.modeOptionsConst as readonly string[]).includes(value)
  }
}
