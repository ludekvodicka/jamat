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
  diffTool: VersioningDiffTool
}

export type VersioningDiffTool = { kind: 'internal' } | { kind: 'external'; command: string; argumentTemplate: string }

export type VersioningSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

export class VersioningSettings {
  static readonly modeOptionsConst: readonly VersioningMode[] = ['checkpoints', 'git']
  static readonly defaultModeConst: VersioningMode = 'checkpoints'

  static tortoiseMerge(): VersioningDiffTool {
    return { kind: 'external', command: 'C:\\Program Files\\TortoiseSVN\\bin\\TortoiseMerge.exe',
      argumentTemplate: '/base:%base /mine:%mine /basename:%bname /minename:%yname' }
  }

  static argumentsOf(template: string): string[] | null {
    const args: string[] = []
    let quote: string | null = null
    let token = ''
    let started = false
    for (const character of template) {
      if (quote !== null) {
        if (character === quote) quote = null
        else token += character
      } else if (character === '"' || character === "'") { quote = character; started = true }
      else if (/\s/.test(character)) {
        if (started) args.push(token)
        token = ''; started = false
      } else { token += character; started = true }
    }
    if (quote !== null) return null
    if (started) args.push(token)
    return args
  }

  static isDiffTool(value: unknown): value is VersioningDiffTool {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const tool = value as Record<string, unknown>
    if (tool.kind === 'internal') return true
    if (tool.kind !== 'external') return false
    return typeof tool.command === 'string' && tool.command.trim().length > 0
      && typeof tool.argumentTemplate === 'string'
      && /%base\b/.test(tool.argumentTemplate) && /%mine\b/.test(tool.argumentTemplate)
      && VersioningSettings.argumentsOf(tool.argumentTemplate) !== null
  }

  static defaultValue(): VersioningSettingsValue {
    return { mode: VersioningSettings.defaultModeConst, diffTool: { kind: 'internal' } }
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
    const mode = VersioningSettings.isMode(document.mode) ? document.mode : VersioningSettings.defaultModeConst
    if (document.mode !== undefined && !VersioningSettings.isMode(document.mode))
      report(
        'The versioning section of config.json has an unusable mode '
        + `(${JSON.stringify(document.mode)}); reading it as checkpoints`,
      )
    const diffTool = VersioningSettings.isDiffTool(document.diffTool) ? document.diffTool : { kind: 'internal' as const }
    if (document.diffTool !== undefined && !VersioningSettings.isDiffTool(document.diffTool))
      report('The versioning diff tool is unusable; reading it as internal')
    return { ...document, mode, diffTool }
  }

  /** Writing is strict, which is what keeps the file readable by the next version that reads it. */
  static isValid(value: unknown): value is VersioningSettingsValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const document = value as Partial<Record<keyof VersioningSettingsValue, unknown>>
    return VersioningSettings.isMode(document.mode) && VersioningSettings.isDiffTool(document.diffTool)
  }

  private static isMode(value: unknown): value is VersioningMode {
    return typeof value === 'string'
      && (VersioningSettings.modeOptionsConst as readonly string[]).includes(value)
  }
}
