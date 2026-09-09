/**
 * Committed in both VCS, then deleted from the working copy. FileViewer classifies it as
 * `missing`, so the only mode it offers is Diff: there is no current content to render.
 */
export class Removed {
  static readonly fate = 'deleted from the working copy'
}
