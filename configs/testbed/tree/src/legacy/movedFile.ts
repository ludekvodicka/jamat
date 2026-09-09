/**
 * The generator renames this file in the WORKING COPY and leaves the rename uncommitted.
 * Git reports it as renamed and carries the source path; SVN reports a delete plus an add,
 * because its working-copy status has no previous path. Both are correct, and File Changes
 * has to show each of them the way its VCS reports it.
 */
export class MovedFile {
  static readonly reason = 'renamed in the working copy, on purpose'

  static describe(): string {
    return `MovedFile: ${MovedFile.reason}`
  }
}
