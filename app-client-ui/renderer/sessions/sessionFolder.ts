import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/**
 * The folder a session is IN, as a path this client can draw. Three surfaces asked it and two of
 * them had written the same four lines out; the third asked the fuller question and inlined the
 * first three lines of the answer beneath its own.
 *
 * The `default` arm answers null, and that is a DELIBERATE disagreement with the library's
 * `LaunchPlanner.directoryOf`, which answers `homedir()`. They are two different questions. The
 * library needs a real directory to spawn a child in and resolves the default on the machine that
 * runs it. This asks what path to put on screen, and the Host that owns the default may be another
 * machine entirely, so there is no path here to name. Drawing a client's own home directory would
 * be a plain lie about where the session is.
 */
export class SessionFolder {
  /** The directory the session was bound to, which for a worktree session names only the repo. */
  static ofDirectory(directory: SessionInfo['directory']): string | null {
    if (directory.mode === 'project') return directory.projectPath
    else if (directory.mode === 'adHoc') return directory.path
    else if (directory.mode === 'default') return null
    else throw new Error(`Unknown session directory: ${JSON.stringify(directory)}`)
  }

  /** Where it actually RUNS: a worktree session runs in its worktree, not in the repo it came from. */
  static ofSession(info: SessionInfo): string | null {
    if (info.worktree !== undefined) return info.worktree.worktreePath
    return SessionFolder.ofDirectory(info.directory)
  }
}
