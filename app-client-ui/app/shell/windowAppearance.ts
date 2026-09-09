import { type WindowAppearance, WindowAppearanceLimits } from '../../shared/windowInfo'

export class WindowAppearanceRules {
  private static readonly controlPatternConst = /[\u0000-\u001f\u007f-\u009f]/u

  /** The one rule for what a window colour is, so a stored one can be checked before it is used. */
  static isColor(value: string): boolean {
    return WindowAppearanceLimits.colorPattern.test(value.trim())
  }

  static normalize(value: WindowAppearance): WindowAppearance {
    if (typeof value !== 'object' || value === null)
      throw new Error(`Invalid window appearance: ${JSON.stringify(value)}`)
    return {
      name: WindowAppearanceRules.normalizeName(value.name),
      color: WindowAppearanceRules.normalizeColor(value.color),
    }
  }

  private static normalizeName(value: string | null): string | null {
    if (value !== null && typeof value !== 'string')
      throw new Error(`Invalid window name: ${JSON.stringify(value)}`)
    if (value === null)
      return null
    const trimmed = value.trim()
    if (trimmed.length === 0)
      return null
    if (trimmed.length > WindowAppearanceLimits.nameCharacters)
      throw new Error(`Window name exceeds ${WindowAppearanceLimits.nameCharacters} characters`)
    if (WindowAppearanceRules.controlPatternConst.test(trimmed))
      throw new Error('Window name contains control characters')
    return trimmed
  }

  private static normalizeColor(value: string | null): string | null {
    if (value !== null && typeof value !== 'string')
      throw new Error(`Invalid window color: ${JSON.stringify(value)}`)
    if (value === null)
      return null
    const trimmed = value.trim()
    if (trimmed.length === 0)
      return null
    if (!WindowAppearanceLimits.colorPattern.test(trimmed))
      throw new Error(`Invalid window color: ${JSON.stringify(value)}`)
    return trimmed.toLowerCase()
  }
}
