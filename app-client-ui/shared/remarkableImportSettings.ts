export interface RemarkableImportSettingsValue {
  /**
   * Whether the import card asks the tablet for the open page the moment it opens, instead of
   * waiting for the user to press the button. Off by default: opening the card contacts no device
   * unless the user has said it may.
   */
  autoPreviewOnOpen: boolean
}

/**
 * How the import card behaves, as opposed to where its result is kept (`remarkableStorage`) or how
 * the tablet is reached (`remarkable`). Its own section for the reason the storage one has its own:
 * a card that loads and saves a whole section would undo what another card had just written.
 */
export class RemarkableImportSettings {
  static readonly defaultAutoPreviewOnOpenConst = false

  static defaultValue(): RemarkableImportSettingsValue {
    return { autoPreviewOnOpen: RemarkableImportSettings.defaultAutoPreviewOnOpenConst }
  }

  static coerce(value: unknown, report: (message: string) => void): RemarkableImportSettingsValue {
    if (value === undefined) return RemarkableImportSettings.defaultValue()
    if (!RemarkableImportSettings.isRecord(value)) {
      report('The remarkableImport section of config.json is not an object; reading it as default')
      return RemarkableImportSettings.defaultValue()
    }
    if (typeof value['autoPreviewOnOpen'] !== 'boolean') {
      if (value['autoPreviewOnOpen'] !== undefined)
        report('The remarkableImport section of config.json has an unusable autoPreviewOnOpen '
          + `(${JSON.stringify(value['autoPreviewOnOpen'])}); reading it as `
          + `${RemarkableImportSettings.defaultAutoPreviewOnOpenConst}`)
      return RemarkableImportSettings.defaultValue()
    }
    return { autoPreviewOnOpen: value['autoPreviewOnOpen'] }
  }

  static isValid(value: unknown): value is RemarkableImportSettingsValue {
    return RemarkableImportSettings.isRecord(value)
      && typeof value['autoPreviewOnOpen'] === 'boolean'
  }

  static isDamaged(value: unknown): boolean {
    if (value === undefined) return false
    if (!RemarkableImportSettings.isRecord(value)) return true
    return value['autoPreviewOnOpen'] !== undefined
      && typeof value['autoPreviewOnOpen'] !== 'boolean'
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
