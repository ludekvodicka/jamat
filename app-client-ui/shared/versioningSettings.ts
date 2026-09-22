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
  activateSessionOnCommit?: boolean
  returnToPreviousSessionAfterCommit?: boolean
  /**
   * How long after the review opened the return still happens, in minutes; 0 means no limit.
   * A review answered in seconds is an interruption and the person wants their own tab back. One
   * they sat in for half an hour is where they now WORK, and taking them out of it is the
   * interruption, so the return expires rather than waiting for however long the commit took.
   */
  returnToPreviousSessionWithinMinutes?: number
  closeCommitOnSuccess?: boolean
  commitSplitRatio?: number
}

export type VersioningSettingsField = keyof VersioningSettingsValue | 'commitReview'

export type VersioningDiffTool = { kind: 'internal' } | { kind: 'external'; command: string; argumentTemplate: string }

export type VersioningSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

export class VersioningSettings {
  static readonly modeOptionsConst: readonly VersioningMode[] = ['checkpoints', 'git']
  static readonly defaultModeConst: VersioningMode = 'checkpoints'
  static readonly defaultReturnWithinMinutesConst = 5
  static readonly maxReturnWithinMinutesConst = 1_440
  static readonly defaultCommitSplitRatioConst = 0.75
  static readonly minCommitSplitRatioConst = 0.15
  static readonly maxCommitSplitRatioConst = 0.85

  static isCommitSplitRatio(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
      && value >= VersioningSettings.minCommitSplitRatioConst && value <= VersioningSettings.maxCommitSplitRatioConst
  }

  static tortoiseMerge(): VersioningDiffTool {
    return { kind: 'external', command: 'C:\\Program Files\\TortoiseSVN\\bin\\TortoiseMerge.exe',
      argumentTemplate: '/base:"$1" /mine:"$2"' }
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
      && /\$1(?!\d)|%base\b/.test(tool.argumentTemplate) && /\$2(?!\d)|%mine\b/.test(tool.argumentTemplate)
      && VersioningSettings.argumentsOf(tool.argumentTemplate) !== null
  }

  static defaultValue(): VersioningSettingsValue {
    return { mode: VersioningSettings.defaultModeConst, diffTool: { kind: 'internal' }, activateSessionOnCommit: true,
      returnToPreviousSessionAfterCommit: true, returnToPreviousSessionWithinMinutes: VersioningSettings.defaultReturnWithinMinutesConst,
      closeCommitOnSuccess: true }
  }

  static fieldsOf(field: VersioningSettingsField): readonly (keyof VersioningSettingsValue)[] {
    if (field === 'commitReview')
      return ['activateSessionOnCommit', 'returnToPreviousSessionAfterCommit', 'returnToPreviousSessionWithinMinutes']
    else if (field === 'mode' || field === 'diffTool' || field === 'activateSessionOnCommit'
      || field === 'returnToPreviousSessionAfterCommit' || field === 'returnToPreviousSessionWithinMinutes'
      || field === 'closeCommitOnSuccess' || field === 'commitSplitRatio') return [field]
    else throw new Error(`Unknown versioning setting: ${String(field)}`)
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
    const activateSessionOnCommit = typeof document.activateSessionOnCommit === 'boolean' ? document.activateSessionOnCommit : true
    if (document.activateSessionOnCommit !== undefined && typeof document.activateSessionOnCommit !== 'boolean')
      report('The commit activation setting is unusable; reading it as enabled')
    const returnToPreviousSessionAfterCommit = typeof document.returnToPreviousSessionAfterCommit === 'boolean'
      ? document.returnToPreviousSessionAfterCommit : true
    if (document.returnToPreviousSessionAfterCommit !== undefined && typeof document.returnToPreviousSessionAfterCommit !== 'boolean')
      report('The commit session return setting is unusable; reading it as enabled')
    const returnToPreviousSessionWithinMinutes = VersioningSettings.isReturnWithin(document.returnToPreviousSessionWithinMinutes)
      ? document.returnToPreviousSessionWithinMinutes : VersioningSettings.defaultReturnWithinMinutesConst
    if (document.returnToPreviousSessionWithinMinutes !== undefined && !VersioningSettings.isReturnWithin(document.returnToPreviousSessionWithinMinutes))
      report(`The commit return window is unusable; reading it as ${VersioningSettings.defaultReturnWithinMinutesConst} minutes`)
    const closeCommitOnSuccess = typeof document.closeCommitOnSuccess === 'boolean' ? document.closeCommitOnSuccess : true
    if (document.closeCommitOnSuccess !== undefined && typeof document.closeCommitOnSuccess !== 'boolean')
      report('The commit closing setting is unusable; reading it as enabled')
    const commitSplitRatio = VersioningSettings.isCommitSplitRatio(document.commitSplitRatio)
      ? document.commitSplitRatio : VersioningSettings.defaultCommitSplitRatioConst
    if (document.commitSplitRatio !== undefined && !VersioningSettings.isCommitSplitRatio(document.commitSplitRatio))
      report('The commit split ratio is unusable; reading it as 75%')
    return { ...document, mode, diffTool, activateSessionOnCommit, returnToPreviousSessionAfterCommit,
      returnToPreviousSessionWithinMinutes, closeCommitOnSuccess,
      commitSplitRatio: document.commitSplitRatio === undefined ? undefined : commitSplitRatio }
  }

  /** Writing is strict, which is what keeps the file readable by the next version that reads it. */
  static isValid(value: unknown): value is VersioningSettingsValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const document = value as Partial<Record<keyof VersioningSettingsValue, unknown>>
    return VersioningSettings.isMode(document.mode) && VersioningSettings.isDiffTool(document.diffTool)
      && (document.activateSessionOnCommit === undefined || typeof document.activateSessionOnCommit === 'boolean')
      && (document.returnToPreviousSessionAfterCommit === undefined || typeof document.returnToPreviousSessionAfterCommit === 'boolean')
      && (document.returnToPreviousSessionWithinMinutes === undefined || VersioningSettings.isReturnWithin(document.returnToPreviousSessionWithinMinutes))
      && (document.closeCommitOnSuccess === undefined || typeof document.closeCommitOnSuccess === 'boolean')
      && (document.commitSplitRatio === undefined || VersioningSettings.isCommitSplitRatio(document.commitSplitRatio))
  }

  /**
   * The return window as the tab broker takes it: milliseconds, or null when the person asked for
   * no limit at all, which is what this did before the window existed.
   */
  static returnWindowMilliseconds(value: VersioningSettingsValue): number | null {
    const minutes = value.returnToPreviousSessionWithinMinutes ?? VersioningSettings.defaultReturnWithinMinutesConst
    return minutes === 0 ? null : minutes * 60_000
  }

  private static isReturnWithin(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      && value <= VersioningSettings.maxReturnWithinMinutesConst
  }

  private static isMode(value: unknown): value is VersioningMode {
    return typeof value === 'string'
      && (VersioningSettings.modeOptionsConst as readonly string[]).includes(value)
  }
}
