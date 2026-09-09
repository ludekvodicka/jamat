/**
 * The ceilings this subsystem works under. All of them exist for one reason: everything here runs in
 * the Electron main process, behind a sidebar somebody is looking at, and spawns other programs.
 */
export class FileChangesLimits {
  /**
   * How long one `git` or `svn` call may take before it is given up on.
   *
   * The shared default is ten minutes, chosen for worktree operations that legitimately run for
   * minutes. These are reads a person is waiting for, and two of them - `svn log` and `svn cat` -
   * talk to the repository SERVER, so an unreachable one used to hold the panel on
   * "Reading changes..." for ten minutes with no way to cancel and a fresh ten-minute child on every
   * Refresh.
   */
  static readonly readTimeoutMilliseconds = 20_000

  /**
   * How many child processes one history read may have in flight.
   *
   * A hundred commits meant a hundred concurrent `git diff-tree`, and on Windows a spawn costs tens
   * of milliseconds of kernel work each. Nothing else in the main process runs while that happens.
   */
  static readonly historyConcurrency = 8

  /** How many `fs.stat` calls the listing may have in flight, for the same reason. */
  static readonly listingConcurrency = 16

  /**
   * How many entries a listing will build.
   *
   * `status` asks git for `--untracked-files=all` on purpose, so an unignored `out/` or
   * `node_modules` puts every file inside it in the answer. Past this the list says it was cut
   * rather than growing into a snapshot of tens of megabytes crossing the IPC boundary.
   */
  static readonly listingEntriesMax = 5_000

  /** How much of a tool's own output may become the text of a warning. */
  static readonly failureDetailCharactersMax = 2_000
}
