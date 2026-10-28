import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { ErrnoCode } from '../shared/errnoCode'

/**
 * What the administrative databases of working copies look like on disk, read with `stat` alone.
 * Every svn write (update, commit, revert, resolve, a lock) changes `.svn/wc.db` and a read never
 * does, so an unchanged stamp means svn would report the same versioned state as before.
 */
export class SvnWcStamp {
  /** The nearest directory at or above `dir` that holds `.svn/wc.db`, or null outside a working copy. */
  static async rootOf(dir: string): Promise<string | null> {
    for (let candidate = resolve(dir); ; candidate = dirname(candidate)) {
      if (await SvnWcStamp.statOf(join(candidate, '.svn', 'wc.db')) !== null) return candidate
      if (dirname(candidate) === candidate) return null
    }
  }

  static async of(roots: readonly string[]): Promise<string> {
    const parts = await Promise.all(roots.flatMap((root) => ['wc.db', 'wc.db-wal'].map(async (name) => {
      const found = await SvnWcStamp.statOf(join(root, '.svn', name))
      return `${root}/${name}:${found === null ? '-' : `${found.mtimeMs}:${found.size}`}`
    })))
    return parts.join('\n')
  }

  private static async statOf(path: string): Promise<{ mtimeMs: number; size: number } | null> {
    return stat(path).catch((error: unknown) => {
      const code = ErrnoCode.of(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    })
  }
}
