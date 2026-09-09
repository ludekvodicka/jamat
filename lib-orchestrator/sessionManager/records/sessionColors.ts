import type { SessionColorName } from '../sessionManagerApi.types'

/**
 * The closed set of colour names, and the one guard over it.
 *
 * Two callers read it for two different reasons, and the asymmetry is deliberate: a WRITE is refused
 * when the name is not one of these, because a caller offering a name nobody can draw has made a
 * mistake worth hearing about. A READ merely filters, because a record carrying a name this build
 * does not know is still a session somebody is working in, and dropping the record over its colour
 * would cost them the session to save the decoration.
 */
export class SessionColors {
  static readonly namesConst = [
    'red', 'orange', 'amber', 'green', 'teal', 'cyan',
    'sky', 'blue', 'indigo', 'violet', 'magenta', 'rose',
  ] as const satisfies readonly SessionColorName[]

  /**
   * Public only so it counts as read: its whole job is to be a type that stops compiling. Without
   * it this list was merely ANNOTATED, so a name added to the union left it behind silently - and
   * this is the list that decides whether a colour can be STORED at all, while its renderer twin,
   * which only draws squares, was the one the compiler guarded.
   */
  static readonly completeConst:
    [Exclude<SessionColorName, (typeof SessionColors.namesConst)[number]>] extends [never]
      ? true
      : never = true

  static isName(value: unknown): value is SessionColorName {
    return typeof value === 'string'
      && SessionColors.namesConst.includes(value as SessionColorName)
  }
}
