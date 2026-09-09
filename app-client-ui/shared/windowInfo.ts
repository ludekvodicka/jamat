export type WindowRole = 'main' | 'holder'

/**
 * What a window's name and colour may be. Both ends of this wire have to agree: the card offers
 * the field and the palette, and the main process refuses a write that breaks either rule - so
 * written twice, a raised limit leaves the field truncating at the old one and a widened colour
 * pattern leaves the palette throwing. The same shape as the `*Limits` classes the library shares
 * with the renderer, in the package-level `shared/` both programs here already read.
 */
export class WindowAppearanceLimits {
  static readonly nameCharacters = 80
  static readonly colorPattern = /^#[0-9a-f]{6}$/i
}

export interface WindowAppearance {
  name: string | null
  color: string | null
}

export interface WindowInfo extends WindowAppearance {
  windowId: string
  role: WindowRole
}
