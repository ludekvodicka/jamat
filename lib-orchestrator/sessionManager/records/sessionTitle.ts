import type { SessionTitleParts } from '../sessionManagerApi.types'

/**
 * The one owner of the title's numeric prefix. `SessionNumberStore` recovers its counters through
 * this expression and `sessionInfoOf` splits every title with it, so the two can never disagree
 * about what a prefix is - and the renderer never parses one, it reads the parts off the wire.
 */
export class SessionTitle {
  /**
   * A number the CALLER brings, which the project never counts: `i34` for issue 34, `pr1200` for a
   * pull request. Letters then digits is the whole of what tells it apart from an allocated `014`,
   * and it is why nothing had to be taught to skip it - `Number('i34')` is `NaN`, so
   * `allocatedNumberOf` answers null and every seed that rebuilds a project's count reads past it.
   *
   * **The bounds are what keeps an ordinary name out of this slot.** Three letters at most and one
   * digit at least, so `hotfix for the parser` stays a name; `x64 build` does not, and is refused
   * as a name rather than quietly drawn behind an `x64` chip. That refusal is the same one digits
   * have always carried, on the same reasoning: a title is the only storage there is, so a shape
   * that reads back as a number IS one.
   */
  static readonly customNumberConst = /^[A-Za-z]{1,3}\d{1,6}$/
  /**
   * `014 - feature name`, `i34 - ticket work`, the fork pairs `014-015` and `i34-015`, and any of
   * those tokens alone when there is no name. The right half of a pair is always an allocated
   * number, because that is the half a fork spends.
   */
  static readonly titlePrefixConst = /^((?:[A-Za-z]{1,3}\d{1,6}|\d{3,})(?:-\d{3,})?)(?:\s|$)/
  /**
   * What a caller may name a session by. The same two tokens the prefix holds, anchored whole, so
   * the selector and the title cannot end up disagreeing about what a number looks like - the
   * selector said `\d{3}` and the title said `\d{3,}` until 2026-09-22, which left a project past
   * its 999th session unreachable by the number it was drawing.
   */
  static readonly selectorConst = /^(?:[A-Za-z]{1,3}\d{1,6}|\d{3,})(?:-\d{3,})?$/
  /** Bounds every wire that carries one: `iii123456-999999` is the longest shape above. */
  static readonly numberCharactersConst = 16
  /** What sits between the number and the name: spaces, at most one dash. */
  private static readonly separatorConst = /^\s*-?\s*/

  static partsOf(title: string): SessionTitleParts {
    const matched = SessionTitle.titlePrefixConst.exec(title)
    if (!matched) return { number: null, name: title }
    const name = title.slice(matched[1].length).replace(SessionTitle.separatorConst, '')
    return { number: matched[1], name }
  }

  /** Whether a caller's number is one the project does not have to count. */
  static isCustomNumber(value: string): boolean {
    return SessionTitle.customNumberConst.test(value)
  }

  /** Whether a caller may select a session by this, allocated or custom, alone or as a fork pair. */
  static isSelectorNumber(value: string): boolean {
    return SessionTitle.selectorConst.test(value)
  }

  /** The inverse of `partsOf`, always in the canonical `${number} - ${name}` spelling. */
  static compose(number: string | null, name: string): string {
    if (number === null) return name
    return name === '' ? number : `${number} - ${name}`
  }

  /** A fork keeps the original number on the left and spends its own number on the right. */
  static composeFork(
    parentNumber: string | null,
    allocatedNumber: string | null,
    name: string,
  ): string {
    if (allocatedNumber === null) return name
    const originalNumber = parentNumber?.split('-')[0] ?? null
    return SessionTitle.compose(
      originalNumber === null ? allocatedNumber : `${originalNumber}-${allocatedNumber}`,
      name,
    )
  }

  /**
   * The number this title spent from the project counter, which is the rightmost fork segment.
   * A custom number spends nothing, so `i34` answers null and `i34-015` answers the 15 its fork
   * did spend.
   */
  static allocatedNumberOf(title: string): number | null {
    const number = SessionTitle.partsOf(title).number
    if (number === null) return null
    const allocated = Number(number.split('-').at(-1))
    return Number.isFinite(allocated) ? allocated : null
  }

  /** A title is one line: newlines collapse to a space rather than travelling into the stores. */
  static normalizeName(raw: string): string {
    return raw.replace(/[\r\n]+/g, ' ').trim()
  }
}
