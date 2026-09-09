export type SessionsTabsView = 'separated' | 'together' | 'states'

/**
 * The rules of the sessions panel's grouping choice, with no React and no DOM. It lives in `shared/`
 * for the reason `sidebarsState.ts` does - the renderer applies it and the main process validates
 * what it is asked to store - and it is a key of its own in the document rather than a field of the
 * sidebars, because the two are written at different cadences: a sidebar width lands on every drag
 * of the splitter, and this lands when somebody presses the button.
 */
export class SessionsViewState {
  /** Two trees, because that is the arrangement that shows both kinds without a second click. */
  static readonly defaultConst: SessionsTabsView = 'separated'
  static readonly labelsConst: Record<SessionsTabsView, string> = {
    together: 'All together', separated: 'Tabs separated', states: 'States separated',
  }

  /**
   * Read leniently: this is how the panel looks, not what it holds, so anything unreadable costs one
   * press of a button. A value nobody wrote is silent - it is the first start - and a value somebody
   * wrote wrong is reported, because that one says the file was written by something.
   */
  static coerce(value: unknown, report: (message: string) => void): SessionsTabsView {
    if (value === undefined || value === null)
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
