import { realpath } from 'node:fs/promises'

import { PathCompare } from '../../shared/pathCompare'

/**
 * What makes a grant mean anything: the path it was minted for is still the path it names, and that
 * path is still inside the root the grant was rooted at.
 *
 * It lived as a private static on the facade, so somebody auditing the grant boundary by opening
 * `access/` saw the store and not the check. Every read that hands bytes back asks this again,
 * because a grant is minted once and used for up to two hours: a directory renamed out of the way
 * and a junction put in its place - no administrator rights needed on Windows - turns a path that
 * was inside the root into one that is not, without the grant knowing.
 */
export class FileViewerGrantBoundary {
  static async insideGrant(rootPath: string, path: string): Promise<boolean> {
    try {
      const resolved = await realpath(path)
      // Both halves. The first says the real path is under the root; the second says the path the
      // grant carries has not itself become a link to somewhere else.
      return PathCompare.isInside(rootPath, resolved)
        && PathCompare.comparable(resolved) === PathCompare.comparable(path)
    }
    catch { return false }
  }
}
