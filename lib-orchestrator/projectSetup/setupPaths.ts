import { stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

/** The two path answers this member gives, in one place so the detectors cannot drift apart on them. */
export class SetupPaths {
  /** A directory carrying a manifest's name is not a manifest, so the file test is what decides. */
  static async isFile(path: string): Promise<boolean> {
    try { return (await stat(path)).isFile() }
    catch { return false }
  }

  /**
   * Repository-relative and forward-slashed, `''` for the root itself: `node:path` joins either
   * separator on win32, and one spelling keeps a stored step comparable to the one that produced it.
   *
   * **Null when the path is not inside the repository at all**, which is the invariant `SetupStep.cwd`
   * claims and this is where it is claimed. A bare `relative()` answers `../..` for a project that
   * sits outside the repository its worktree was cut from, and a step carrying that would be joined
   * onto the worktree and run in somebody's real checkout. The lifecycle checks the same thing again
   * on its way to the Host, and that check is a cheap assertion rather than the guard.
   */
  static relativeOf(repositoryRoot: string, path: string): string | null {
    const answer = relative(repositoryRoot, path).replace(/\\/g, '/')
    if (answer === '..' || answer.startsWith('../') || isAbsolute(answer)) return null
    return answer
  }
}
