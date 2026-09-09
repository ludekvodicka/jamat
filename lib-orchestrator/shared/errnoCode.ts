/**
 * The `code` of something thrown by a `node:` call, or null when there is none to read.
 *
 * `in` rather than `(error as NodeJS.ErrnoException).code`: a `catch` binds an `unknown`, and what
 * arrives there is whatever was thrown - a string, a null, an object with no `code` at all. The cast
 * says the field is there and reading it off a `null` throws inside the handler that exists to stop
 * a throw.
 */
export class ErrnoCode {
  static of(error: unknown): string | null {
    return typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string'
      ? error.code
      : null
  }
}
