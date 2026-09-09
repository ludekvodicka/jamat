/**
 * This one is renamed and COMMITTED in the second revision and the second commit, so the
 * rename shows up in a history group instead of in the working-copy listing. SVN carries the
 * copied-from path in its log, which is the only place its rename source appears.
 */
export class HistoryRename {
  static readonly reason = 'renamed in history, not in the working copy'

  static describe(): string {
    return `HistoryRename: ${HistoryRename.reason}`
  }
}
