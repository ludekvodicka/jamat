/** Where a finished reMarkable import is kept. */
export type RemarkableStorageScope = 'global' | 'project'

export interface RemarkableStorageSettingsValue {
  scope: RemarkableStorageScope
  /**
   * Relative to the session's own working directory. Kept while the scope is global too, so turning
   * per-project storage off and on again does not lose the path the user typed.
   */
  projectDirectory: string
}

/**
 * The directory a project-scoped import goes to, validated as TEXT.
 *
 * The renderer compiles this file, so there is no `node:path` here and nothing resolves: what these
 * rules produce is a path fragment that is safe to join onto a directory the MAIN process chose.
 * Every escape a fragment could attempt - a drive letter, a leading separator, a `..` segment, an
 * NTFS stream after a colon - is refused before the join rather than detected after it.
 */
export class RemarkableStorageSettings {
  static readonly scopeOptionsConst: readonly RemarkableStorageScope[] = ['global', 'project']
  static readonly defaultScopeConst: RemarkableStorageScope = 'global'
  static readonly defaultProjectDirectoryConst = '.remarkable'
  static readonly projectDirectoryLengthMaxConst = 200
  private static readonly forbiddenCharacterConst = /[:*?"<>|\p{Cc}]/u

  static defaultValue(): RemarkableStorageSettingsValue {
    return {
      scope: RemarkableStorageSettings.defaultScopeConst,
      projectDirectory: RemarkableStorageSettings.defaultProjectDirectoryConst,
    }
  }

  static coerce(value: unknown, report: (message: string) => void): RemarkableStorageSettingsValue {
    if (value === undefined) return RemarkableStorageSettings.defaultValue()
    if (!RemarkableStorageSettings.isRecord(value)) {
      report('The remarkableStorage section of config.json is not an object; reading it as global')
      return RemarkableStorageSettings.defaultValue()
    }

    const result: Record<string, unknown> = { ...value }
    if (!RemarkableStorageSettings.isScope(value['scope'])) {
      if (value['scope'] !== undefined)
        report(`The remarkableStorage section of config.json has an unusable scope `
          + `(${JSON.stringify(value['scope'])}); reading it as `
          + `${RemarkableStorageSettings.defaultScopeConst}`)
      result['scope'] = RemarkableStorageSettings.defaultScopeConst
    }
    if (!RemarkableStorageSettings.isProjectDirectory(value['projectDirectory'])) {
      if (value['projectDirectory'] !== undefined)
        report(`The remarkableStorage section of config.json has an unusable projectDirectory `
          + `(${JSON.stringify(value['projectDirectory'])}); reading it as `
          + `${RemarkableStorageSettings.defaultProjectDirectoryConst}`)
      result['projectDirectory'] = RemarkableStorageSettings.defaultProjectDirectoryConst
    }

    if (!RemarkableStorageSettings.isValid(result))
      throw new Error('The reMarkable storage settings coercer produced an invalid value')
    return result
  }

  static isValid(value: unknown): value is RemarkableStorageSettingsValue {
    if (!RemarkableStorageSettings.isRecord(value)) return false
    return RemarkableStorageSettings.isScope(value['scope'])
      && RemarkableStorageSettings.isProjectDirectory(value['projectDirectory'])
  }

  /**
   * A hand-edit worth keeping the owner off its own save. An absent key is not damage - it is a file
   * written before this section existed, and the default is the right reading of it.
   */
  static isDamaged(value: unknown): boolean {
    if (value === undefined) return false
    if (!RemarkableStorageSettings.isRecord(value)) return true
    if (value['scope'] !== undefined && !RemarkableStorageSettings.isScope(value['scope']))
      return true
    return value['projectDirectory'] !== undefined
      && !RemarkableStorageSettings.isProjectDirectory(value['projectDirectory'])
  }

  static isScope(value: unknown): value is RemarkableStorageScope {
    return typeof value === 'string'
      && (RemarkableStorageSettings.scopeOptionsConst as readonly string[]).includes(value)
  }

  static isProjectDirectory(value: unknown): value is string {
    return RemarkableStorageSettings.projectDirectoryProblem(value) === null
  }

  /**
   * The reason the directory cannot be used, or null. The card shows this sentence, so each refusal
   * names the thing the user typed rather than saying the value is invalid.
   */
  static projectDirectoryProblem(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0)
      return 'Enter a folder inside the project, for example .aidocs/remarkable.'
    if (value.length > RemarkableStorageSettings.projectDirectoryLengthMaxConst)
      return `Keep the folder under ${RemarkableStorageSettings.projectDirectoryLengthMaxConst} characters.`
    if (value !== value.trim()) return 'Remove the space at the start or the end.'
    if (RemarkableStorageSettings.forbiddenCharacterConst.test(value))
      return 'Use letters, digits, dots, dashes and slashes only.'
    if (value.startsWith('/') || value.startsWith('\\'))
      return 'Use a folder inside the project, not one starting at the drive root.'
    const segments = value.split(/[/\\]/)
    for (const segment of segments) {
      if (segment.length === 0) return 'Remove the empty step in the path.'
      if (segment === '.' || segment === '..')
        return 'Use a folder inside the project, without . or .. steps.'
      if (segment !== segment.trim()) return 'Remove the space around a folder name.'
      if (segment.endsWith('.')) return 'A folder name cannot end with a dot.'
    }
    return null
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
