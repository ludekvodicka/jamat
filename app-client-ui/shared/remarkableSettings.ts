export interface RemarkableSettingsValue {
  host?: string
  fingerprint?: string
  timeoutMilliseconds: number
}

export class RemarkableSettings {
  static readonly timeoutMillisecondsMinConst = 1_000
  static readonly timeoutMillisecondsMaxConst = 600_000
  static readonly timeoutMillisecondsDefaultConst = 180_000
  private static readonly fingerprintShapeConst = /^SHA256:[A-Za-z0-9+/]{43}$/
  private static readonly forbiddenHostCharacterConst = /[\s\p{Cc}]/u

  static defaultValue(): RemarkableSettingsValue {
    return { timeoutMilliseconds: RemarkableSettings.timeoutMillisecondsDefaultConst }
  }

  static coerce(value: unknown, report: (message: string) => void): RemarkableSettingsValue {
    if (value === undefined) return RemarkableSettings.defaultValue()
    if (!RemarkableSettings.isRecord(value)) {
      report('The remarkable section of config.json is not an object; reading it as unconfigured')
      return RemarkableSettings.defaultValue()
    }

    const result: Record<string, unknown> = { ...value }
    if (value['host'] !== undefined && !RemarkableSettings.isValidHost(value['host'])) {
      report(`The remarkable section of config.json has an unusable host `
        + `(${JSON.stringify(value['host'])}); reading it as unconfigured`)
      delete result['host']
    }
    if (value['fingerprint'] !== undefined
      && !RemarkableSettings.isValidFingerprint(value['fingerprint'])) {
      report(`The remarkable section of config.json has an unusable fingerprint `
        + `(${JSON.stringify(value['fingerprint'])}); reading it as unconfigured`)
      delete result['fingerprint']
    }
    if (!RemarkableSettings.isValidTimeout(value['timeoutMilliseconds'])) {
      if (value['timeoutMilliseconds'] !== undefined)
        report(`The remarkable section of config.json has an unusable timeoutMilliseconds `
          + `(${JSON.stringify(value['timeoutMilliseconds'])}); reading it as `
          + `${RemarkableSettings.timeoutMillisecondsDefaultConst}`)
      result['timeoutMilliseconds'] = RemarkableSettings.timeoutMillisecondsDefaultConst
    }

    if (!RemarkableSettings.isValid(result))
      throw new Error('The reMarkable settings coercer produced an invalid value')
    return result
  }

  static isValid(value: unknown): value is RemarkableSettingsValue {
    if (!RemarkableSettings.isRecord(value)) return false
    if (value['host'] !== undefined && !RemarkableSettings.isValidHost(value['host'])) return false
    if (value['fingerprint'] !== undefined
      && !RemarkableSettings.isValidFingerprint(value['fingerprint'])) return false
    return RemarkableSettings.isValidTimeout(value['timeoutMilliseconds'])
  }

  static isDamaged(value: unknown): boolean {
    if (value === undefined) return false
    if (!RemarkableSettings.isRecord(value)) return true
    if (value['host'] !== undefined && !RemarkableSettings.isValidHost(value['host'])) return true
    if (value['fingerprint'] !== undefined
      && !RemarkableSettings.isValidFingerprint(value['fingerprint'])) return true
    return value['timeoutMilliseconds'] !== undefined
      && !RemarkableSettings.isValidTimeout(value['timeoutMilliseconds'])
  }

  static isValidHost(value: unknown): value is string {
    return typeof value === 'string'
      && value.length > 0
      && !RemarkableSettings.forbiddenHostCharacterConst.test(value)
  }

  static isValidFingerprint(value: unknown): value is string {
    return typeof value === 'string' && RemarkableSettings.fingerprintShapeConst.test(value)
  }

  static isValidTimeout(value: unknown): value is number {
    return typeof value === 'number'
      && Number.isInteger(value)
      && value >= RemarkableSettings.timeoutMillisecondsMinConst
      && value <= RemarkableSettings.timeoutMillisecondsMaxConst
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
