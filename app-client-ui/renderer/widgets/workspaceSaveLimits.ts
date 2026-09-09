/**
 * What the workspace waits before it writes. One debounce for both surfaces beside it: the layout
 * the tabs controller saves and the sidebar sizes the sidebars save land in the same document, and
 * the flush before the window closes assumes a single window with a single timer. Two constants
 * would drift while the comment on each claimed they agree.
 *
 * It lives here, in a file with no imports of its own, rather than on either surface: the sidebar
 * hook used to import the 900-line tabs controller to read this number, which pulled the whole
 * dockview module graph into the sidebar's own graph for a `350`.
 */
export class WorkspaceSaveLimits {
  static readonly debounceMilliseconds = 350
}
