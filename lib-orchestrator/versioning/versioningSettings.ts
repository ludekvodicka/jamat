import type { VersioningMode } from '../git/git.types'

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
  /**
   * How long the person must type nothing before something an agent opened takes the screen, in
   * whole seconds; 0 brings it forward as soon as a workspace window has the focus.
   */
  switchAfterIdleSeconds?: number
  closeCommitOnSuccess?: boolean
  commitSplitRatio?: number
  /**
   * What Finish of a main-copy session types into the session for a commit, per VCS. Jamat commits
   * nothing itself there: the agent knows what the changes are for and writes the message. Absent
   * reads as plain English words any agent understands; a team with its own commit commands, such
   * as `/commit-svn`, names them here.
   */
  finishCommitCommands?: VersioningFinishCommands
}

export interface VersioningFinishCommands {
  svn: string
  git: string
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
  static readonly defaultSwitchAfterIdleSecondsConst = 20
  static readonly maxSwitchAfterIdleSecondsConst = 600
  static readonly defaultCommitSplitRatioConst = 0.75
  static readonly minCommitSplitRatioConst = 0.15
  static readonly maxCommitSplitRatioConst = 0.85
  static readonly defaultFinishCommitCommandsConst: VersioningFinishCommands = {
    svn: "Commit this session's changes to SVN.",
    git: "Commit this session's changes to Git.",
  }
  /** The typed limit of a delivered line (`RemoteControlDeliverConst.textLengthConst`). */
  static readonly maxFinishCommandLengthConst = 800

  static finishCommandOf(value: VersioningSettingsValue, vcs: 'svn' | 'git'): string {
    const commands = value.finishCommitCommands ?? VersioningSettings.defaultFinishCommitCommandsConst
    switch (vcs) {
      case 'svn': return commands.svn
      case 'git': return commands.git
      default: throw new Error(`Unknown VCS: ${JSON.stringify(vcs satisfies never)}`)
    }
  }

  /** One line each, typed into a composer: no line break or other control character. */
  static isFinishCommands(value: unknown): value is VersioningFinishCommands {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const commands = value as Partial<Record<keyof VersioningFinishCommands, unknown>>
    return VersioningSettings.isFinishCommand(commands.svn) && VersioningSettings.isFinishCommand(commands.git)
  }

  private static isFinishCommand(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= VersioningSettings.maxFinishCommandLengthConst
      // eslint-disable-next-line no-control-regex
      && !/[\u0000-\u001f\u007f]/.test(value)
  }

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
      switchAfterIdleSeconds: VersioningSettings.defaultSwitchAfterIdleSecondsConst, closeCommitOnSuccess: true }
  }

  static fieldsOf(field: VersioningSettingsField): readonly (keyof VersioningSettingsValue)[] {
    if (field === 'commitReview')
      return ['activateSessionOnCommit', 'returnToPreviousSessionAfterCommit', 'returnToPreviousSessionWithinMinutes', 'switchAfterIdleSeconds']
    else if (field === 'mode' || field === 'diffTool' || field === 'activateSessionOnCommit'
      || field === 'returnToPreviousSessionAfterCommit' || field === 'returnToPreviousSessionWithinMinutes'
      || field === 'switchAfterIdleSeconds' || field === 'closeCommitOnSuccess' || field === 'commitSplitRatio'
      || field === 'finishCommitCommands') return [field]
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
    const switchAfterIdleSeconds = VersioningSettings.isSwitchAfterIdle(document.switchAfterIdleSeconds)
      ? document.switchAfterIdleSeconds : VersioningSettings.defaultSwitchAfterIdleSecondsConst
    if (document.switchAfterIdleSeconds !== undefined && !VersioningSettings.isSwitchAfterIdle(document.switchAfterIdleSeconds))
      report(`The switch-after-typing delay is unusable; reading it as ${VersioningSettings.defaultSwitchAfterIdleSecondsConst} seconds`)
    const closeCommitOnSuccess = typeof document.closeCommitOnSuccess === 'boolean' ? document.closeCommitOnSuccess : true
    if (document.closeCommitOnSuccess !== undefined && typeof document.closeCommitOnSuccess !== 'boolean')
      report('The commit closing setting is unusable; reading it as enabled')
    const commitSplitRatio = VersioningSettings.isCommitSplitRatio(document.commitSplitRatio)
      ? document.commitSplitRatio : VersioningSettings.defaultCommitSplitRatioConst
    if (document.commitSplitRatio !== undefined && !VersioningSettings.isCommitSplitRatio(document.commitSplitRatio))
      report('The commit split ratio is unusable; reading it as 75%')
    const finishCommitCommands = VersioningSettings.isFinishCommands(document.finishCommitCommands) ? document.finishCommitCommands : undefined
    if (document.finishCommitCommands !== undefined && finishCommitCommands === undefined)
      report('The Finish commit commands are unusable; reading them as the default words')
    return { ...document, mode, diffTool, activateSessionOnCommit, returnToPreviousSessionAfterCommit,
      returnToPreviousSessionWithinMinutes, switchAfterIdleSeconds, closeCommitOnSuccess,
      commitSplitRatio: document.commitSplitRatio === undefined ? undefined : commitSplitRatio, finishCommitCommands }
  }

  /** Writing is strict, which is what keeps the file readable by the next version that reads it. */
  static isValid(value: unknown): value is VersioningSettingsValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const document = value as Partial<Record<keyof VersioningSettingsValue, unknown>>
    return VersioningSettings.isMode(document.mode) && VersioningSettings.isDiffTool(document.diffTool)
      && (document.activateSessionOnCommit === undefined || typeof document.activateSessionOnCommit === 'boolean')
      && (document.returnToPreviousSessionAfterCommit === undefined || typeof document.returnToPreviousSessionAfterCommit === 'boolean')
      && (document.returnToPreviousSessionWithinMinutes === undefined || VersioningSettings.isReturnWithin(document.returnToPreviousSessionWithinMinutes))
      && (document.switchAfterIdleSeconds === undefined || VersioningSettings.isSwitchAfterIdle(document.switchAfterIdleSeconds))
      && (document.closeCommitOnSuccess === undefined || typeof document.closeCommitOnSuccess === 'boolean')
      && (document.commitSplitRatio === undefined || VersioningSettings.isCommitSplitRatio(document.commitSplitRatio))
      && (document.finishCommitCommands === undefined || VersioningSettings.isFinishCommands(document.finishCommitCommands))
  }

  /**
   * The return window as the tab broker takes it: milliseconds, or null when the person asked for
   * no limit at all, which is what this did before the window existed.
   */
  static returnWindowMilliseconds(value: VersioningSettingsValue): number | null {
    const minutes = value.returnToPreviousSessionWithinMinutes ?? VersioningSettings.defaultReturnWithinMinutesConst
    return minutes === 0 ? null : minutes * 60_000
  }

  /** The quiet time as the attention queue takes it. */
  static idleMilliseconds(value: VersioningSettingsValue): number {
    return (value.switchAfterIdleSeconds ?? VersioningSettings.defaultSwitchAfterIdleSecondsConst) * 1_000
  }

  private static isSwitchAfterIdle(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      && value <= VersioningSettings.maxSwitchAfterIdleSecondsConst
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
