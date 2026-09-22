export class SessionsPinsState {
  static isValid(value: unknown): value is readonly string[] {
    return Array.isArray(value)
      && value.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 4096)
      && new Set(value).size === value.length
  }

  static coerce(value: unknown, report: (message: string) => void): readonly string[] {
    if (value === undefined) return []
    if (SessionsPinsState.isValid(value)) return [...value]
    report('Stored session pins are invalid; using no pins')
    return []
  }
}
