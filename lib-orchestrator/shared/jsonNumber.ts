/**
 * The number checks every reader of somebody else's JSON makes, each named for what it means.
 *
 * There were five, none of them named at the call site for which of the three questions it asked -
 * finite, a safe integer, or a positive one - so reading a caller told you it wanted "a number" and
 * nothing more. They are different questions: a duration of `0` is a real answer and a duration of
 * `-1` is not, `1e21` is finite and is not a count, and a timestamp read from a file may legitimately
 * be a large integer.
 *
 * Beside `jsonShape.ts` and for the same reason: the first thing asked of anything this tree did not
 * build, written once.
 */
export class JsonNumber {
  /** A number that is neither `NaN` nor an infinity. Says nothing about sign or whole-ness. */
  static isFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
  }

  static finite(value: unknown): number | null {
    return JsonNumber.isFinite(value) ? value : null
  }

  /** A whole number JavaScript can hold exactly: a count, an index, a millisecond timestamp. */
  static safeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
  }

  /** The same, and above zero: a size, a duration, a one-based number. Zero is refused. */
  static positiveInteger(value: unknown): number | null {
    const whole = JsonNumber.safeInteger(value)
    return whole !== null && whole > 0 ? whole : null
  }

  /** The same, and not negative: a count that may legitimately be none. */
  static wholeCount(value: unknown): number | null {
    const whole = JsonNumber.safeInteger(value)
    return whole !== null && whole >= 0 ? whole : null
  }
}
