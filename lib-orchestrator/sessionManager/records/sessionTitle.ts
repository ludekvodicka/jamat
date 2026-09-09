import type { SessionTitleParts } from '../sessionManagerApi.types'

/**
 * The one owner of the title's numeric prefix. `SessionNumberStore` recovers its counters through
 * this expression and `sessionInfoOf` splits every title with it, so the two can never disagree
 * about what a prefix is - and the renderer never parses one, it reads the parts off the wire.
 */
export class SessionTitle {
  /** `014 - feature name`, `014-015 - fork`, and either token alone when there is no name. */
  static readonly titlePrefixConst = /^(\d{3,}(?:-\d{3,})?)(?:\s|$)/
  /** What sits between the number and the name: spaces, at most one dash. */
  private static readonly separatorConst = /^\s*-?\s*/

  static partsOf(title: string): SessionTitleParts {
    const matched = SessionTitle.titlePrefixConst.exec(title)
    if (!matched) return { number: null, name: title }
    const name = title.slice(matched[1].length).replace(SessionTitle.separatorConst, '')
    return { number: matched[1], name }
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

  /** The number this title spent from the project counter, which is the rightmost fork segment. */
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
