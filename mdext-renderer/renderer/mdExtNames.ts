/**
 * The names a callout and a status chip may carry, in one place.
 *
 * Each name used to be written three times: the directive walker's `Set`, the sanitizer's className
 * allowlist and the stylesheet. Adding `:::success` to two of the three left `rehype-sanitize`
 * stripping the class without a word - an unstyled bare div, typecheck green, tests green - so the
 * two that can share a list now do, and `mdExtRenderer.css` is pinned to this list by a test.
 */
export class MdExtNames {
  static readonly calloutsConst = [
    'note', 'tip', 'warning', 'danger', 'important',
  ] as const

  static readonly tonesConst = ['good', 'warn', 'bad', 'neutral'] as const

  static readonly calloutClassesConst: readonly string[] =
    MdExtNames.calloutsConst.map((name) => `mdext-callout-${name}`)

  static readonly chipClassesConst: readonly string[] =
    MdExtNames.tonesConst.map((tone) => `mdext-chip-${tone}`)
}

export type MdExtCallout = typeof MdExtNames.calloutsConst[number]
export type MdExtTone = typeof MdExtNames.tonesConst[number]
