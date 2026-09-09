import { stat } from 'node:fs/promises'

import { FileChangesLimits } from '../fileChangesLimits'
import type { FileChangeNodeKind } from '../fileChangesManagerApi.types'
import type { FileChangesVcs } from './fileChangesVcs.types'

/**
 * What both tools' outcomes have in common, which is all this base reads of them. Structural rather
 * than either concrete type, because git keeps its own failure union and svn now uses the shared one.
 */
export interface VcsCommandOutcome {
  code: number
  stdout: string
  stderr: string
  failure: string | null
}

/**
 * What both adapters do the same way.
 *
 * `FileChangesVcs` was an interface with no base, and the two implementations had grown four
 * identical statics between them: `nodeKindOf` and `repositoryPath` byte for byte, `succeeded` and
 * `detailOf` differing only in the tool's name. The house rule is to share behaviour through an
 * abstract base rather than a loose util, and the difference between the two - the name in the
 * sentence, and the one extra failure git can report - is exactly what a subclass supplies.
 */

export abstract class FileChangesVcsBase implements Pick<FileChangesVcs, 'id'> {
  abstract readonly id: FileChangesVcs['id']

  /** What the tool is called in a sentence a person reads. */
  protected abstract readonly toolName: string

  /** A file or a directory, and a file when it is neither there nor readable. */
  protected static async nodeKindOf(path: string): Promise<FileChangeNodeKind> {
    try { return (await stat(path)).isDirectory() ? 'directory' : 'file' }
    catch { return 'file' }
  }

  /** Forward slashes and no leading `./`, which is how both tools spell a path inside a repository. */
  protected static repositoryPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\//, '')
  }

  protected static succeeded(outcome: VcsCommandOutcome): boolean {
    return outcome.failure === null && outcome.code === 0
  }

  /**
   * Why a command did not work, in one paragraph the renderer draws.
   *
   * Cut, because the output it reads from is capped in megabytes rather than characters.
   */
  protected detailOf(outcome: VcsCommandOutcome): string {
    const message = (outcome.stderr.trim() || outcome.stdout.trim())
      .slice(0, FileChangesLimits.failureDetailCharactersMax)
    return message || (outcome.failure
      ? `${this.toolName} could not run (${outcome.failure})`
      : `${this.toolName} exited with ${outcome.code}`)
  }
}
