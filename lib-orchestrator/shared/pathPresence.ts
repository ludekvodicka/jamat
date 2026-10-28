import { readdir } from 'node:fs/promises'
import { relative, resolve, dirname, basename } from 'node:path'
import { ErrnoCode } from './errnoCode'
import { PathCompare } from './pathCompare'

export class PathPresence {
  static async missing(root: string, paths: readonly string[]): Promise<Set<string>> {
    const missing = new Set<string>()
    const directories = new Map<string, Set<string>>()
    for (const path of paths) {
      let absolute = resolve(root, path)
      if (!PathCompare.isInside(root, absolute)) throw new Error(`Path leaves the root: ${path}`)
      while (relative(root, absolute) !== '') {
        const parent = dirname(absolute)
        let names = directories.get(parent)
        if (names === undefined) {
          try { names = new Set(await readdir(parent)) }
          catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(ErrnoCode.of(error) ?? '')) throw error
            names = new Set()
          }
          directories.set(parent, names)
        }
        // Windows lstat("a") also finds "A" after a case-only move; SVN keeps two distinct nodes.
        if (!names.has(basename(absolute))) { missing.add(path); break }
        absolute = parent
      }
    }
    return missing
  }
}
