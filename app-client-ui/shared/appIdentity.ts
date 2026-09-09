/**
 * What this application calls itself, and the one place that formats a window's title from it.
 *
 * Both processes write a title and both used to carry the rule. Main sets it on the BrowserWindow,
 * so a window wears a name before its renderer has loaded; the renderer then writes
 * `document.title`, which raises `page-title-updated` and overrides whatever main set. The
 * renderer's is therefore the title a person reads, and the two agreeing is not optional - they had
 * the same rule written twice and the name written three times.
 *
 * `renderer/index.html` holds a fourth copy that cannot import this one: it is the title the window
 * wears for the moment between the document loading and the first `WindowInfo` arriving.
 */
export class AppIdentity {
  static readonly nameConst = 'Jamat V3'
  static readonly debugNameConst = `${AppIdentity.nameConst} Debug`

  /** Null is a window with no name of its own, which wears the application's. */
  static titleOf(windowName: string | null): string {
    return windowName === null ? AppIdentity.nameConst : `${AppIdentity.nameConst} - ${windowName}`
  }
}
