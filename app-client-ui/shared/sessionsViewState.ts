export type SessionsTabsView = 'together' | 'states'

/**
 * The rules of the sessions panel's grouping choice, with no React and no DOM. It lives in `shared/`
 * for the reason `sidebarsState.ts` does - the renderer applies it and the main process validates
 * what it is asked to store - and it is a key of its own in the document rather than a field of the
 * sidebars, because the two are written at different cadences: a sidebar width lands on every drag
 * of the splitter, and this lands when somebody presses the button.
 */
export class SessionsViewState {
  /** One tree, which is what the panel holds now that a session is a session wherever it is drawn. */
  static readonly defaultConst: SessionsTabsView = 'together'
  static readonly labelsConst: Record<SessionsTabsView, string> = {
    together: 'All together', states: 'States separated',
  }

  /**
   * Read leniently: this is how the panel looks, not what it holds, so anything unreadable costs one
   * press of a button. A value nobody wrote is silent - it is the first start - and a value somebody
   * wrote wrong is reported, because that one says the file was written by something.
   *
   * `separated` was the third value and the default until 2026-09-23: it drew the plain tabs in a
   * tree of their own. It is silent as well, because a file that still says it was written by the
   * build before that one rather than by something that cannot write this file.
   */
  static coerce(value: unknown, report: (message: string) => void): SessionsTabsView {
    if (value === undefined || value === null || value === 'separated')
      return SessionsViewState.defaultConst
    if (SessionsViewState.isValid(value))
      return value
    report(`Stored sessions view ${JSON.stringify(value)} is not a view; using ${
      SessionsViewState.defaultConst}`)
    return SessionsViewState.defaultConst
  }

  /**
   * The value itself, never its text. The sidebar store used to compare `JSON.stringify` of the
   * coerced value against the raw one, which called the same data damaged for having its keys in
   * another order; a check that looks at the value cannot be fooled that way.
   */
  static isValid(value: unknown): value is SessionsTabsView {
    return typeof value === 'string'
      && Object.hasOwn(SessionsViewState.labelsConst, value)
  }
}
