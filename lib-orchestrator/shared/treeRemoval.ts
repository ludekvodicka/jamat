import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrnoCode } from './errnoCode'

/** How far a counted removal is: the files counted so far, then the files deleted of how many. */
export interface TreeRemovalProgress {
  phase: 'counting' | 'deleting'
  done: number
  /** Null while the count still runs, and for a removal whose walk failed. */
  total: number | null
  /** A program holds this path, and the removal waits to try again (UA1-J11-6). */
  held?: TreeRemovalHeld
}

/** The path an `rm` was refused on, its error code, the try that was refused, of how many, and the wait before the next. */
export interface TreeRemovalHeld {
  path: string
  code: string
  attempt: number
  attempts: number
  delayMilliseconds: number
}

/** How often a counted removal tries a held directory again, and how long it waits between tries. */
export interface TreeRemovalHeldPolicy {
  attempts: number
  delayMilliseconds: number
}

export interface TreeRemovalRmOptions {
  recursive: true
  force: true
  maxRetries: number
  retryDelay: number
}

export type TreeRemovalListener = (progress: TreeRemovalProgress) => void

/**
 * Deletes a file or a whole directory tree; a path that is already gone is no failure. With a
 * listener it counts the files first and then says how many of them are gone.
 */
export type TreeRemove = (path: string, onProgress?: TreeRemovalListener) => Promise<void>

/** One directory entry as the walk reads it. */
export interface TreeRemovalEntry {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** The promise API a remover runs over: Node's own, or `original-fs` inside Electron. */
export interface TreeRemovalFs {
  rm(path: string, options: TreeRemovalRmOptions): Promise<void>
  readdir(path: string, options: { withFileTypes: true }): Promise<TreeRemovalEntry[]>
  lstat(path: string): Promise<Pick<TreeRemovalEntry, 'isDirectory' | 'isSymbolicLink'>>
}

/** A directory the counted walk found; `pending` is how many of its child directories still stand. */
interface WalkedDirectory {
  path: string
  files: number
  pending: number
  parent: WalkedDirectory | null
}

/**
 * How this library deletes a tree the user's tools filled, such as a worktree with its
 * `node_modules`.
 *
 * Node's own `rm` is right in every plain Node process. It is wrong inside Electron, whose `fs`
 * reads any `*.asar` file as an archive directory: a recursive `rm` opens the archive, fails its
 * `rmdir` with EBUSY, and the process keeps the file open until it exits, so not even Explorer can
 * delete it. An Electron composer therefore hands in a remover over `original-fs`, and the counted
 * walk reads through that same fs.
 *
 * The counted removal still deletes with Node's `rm`, one directory at a time, each only after every
 * directory below it is gone, so long paths and the unlink of a junction stay Node's. Its retries
 * are its own: Node retries inside `rm` at every level of the tree, so one held file kept a purge
 * silent for minutes (UA1-J11-6). A counted `rm` retries briefly, and a directory still held is tried
 * again `heldPolicyConst` times, each refusal reported with the held path.
 */
export class TreeRemoval {
  /** Windows keeps a just-closed file locked for a moment, which is what the retries are for. */
  static readonly rmOptionsConst = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as const
  /** About 1.2 s on a held file, which covers a file closed a moment ago; a longer hold is reported. */
  static readonly countedRmOptionsConst = { recursive: true, force: true, maxRetries: 2, retryDelay: 100 } as const
  /** About one minute in all for a held directory; then the removal fails and names the held path. */
  static readonly heldPolicyConst: TreeRemovalHeldPolicy = { attempts: 10, delayMilliseconds: 5_000 }
  private static readonly heldCodesConst = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']
  static readonly node: TreeRemove = TreeRemoval.over({ rm, readdir, lstat })
  /** One call at a time took about three times as long as one `rm` of a real `node_modules` (svn-worktrees.md, Cost). */
  static readonly parallelConst = 8

  static over(fs: TreeRemovalFs, held: TreeRemovalHeldPolicy = TreeRemoval.heldPolicyConst): TreeRemove {
    return async (path, onProgress) => {
      if (onProgress === undefined) return fs.rm(path, TreeRemoval.rmOptionsConst)
      const root = await fs.lstat(path).catch(() => null)
      if (root !== null && (!root.isDirectory() || root.isSymbolicLink())) {
        // A link root is unlinked whole: walking it would count, and remove, its target's files.
        await fs.rm(path, TreeRemoval.rmOptionsConst)
        onProgress({ phase: 'deleting', done: 1, total: 1 })
        return
      }
      const directories = root === null ? null : await TreeRemoval.walk(fs, path, onProgress).catch(() => null)
      if (directories === null) {
        // A tree the walk cannot read still goes; it only goes without a count.
        onProgress({ phase: 'deleting', done: 0, total: null })
        return TreeRemoval.removeHeld(fs, path, held, (refused) => onProgress({ phase: 'deleting', done: 0, total: null, held: refused }))
      }
      await TreeRemoval.removeUp(fs, directories, held, onProgress)
    }
  }

  /**
   * Removes every walked directory once all directories below it are gone, at most
   * `parallelConst` `rm` calls at a time. After a failure no further `rm` starts; the ones in flight
   * end, then the first failure is thrown.
   */
  private static async removeUp(fs: TreeRemovalFs, directories: readonly WalkedDirectory[], held: TreeRemovalHeldPolicy, onProgress: TreeRemovalListener): Promise<void> {
    const total = directories.reduce((sum, directory) => sum + directory.files, 0)
    const slot = TreeRemoval.pool(TreeRemoval.parallelConst)
    let done = 0
    const failures: unknown[] = []
    const remove = async (directory: WalkedDirectory): Promise<void> => {
      const removed = await slot(async () => {
        if (failures.length > 0) return false
        await TreeRemoval.removeHeld(fs, directory.path, held, (refused) => onProgress({ phase: 'deleting', done, total, held: refused }))
        return true
      }).catch((error: unknown) => {
        failures.push(error)
        return false
      })
      if (!removed) return
      done += directory.files
      onProgress({ phase: 'deleting', done, total })
      const parent = directory.parent
      if (parent === null) return
      parent.pending -= 1
      if (parent.pending === 0) await remove(parent)
    }
    await Promise.all(directories.filter((directory) => directory.pending === 0).map(remove))
    if (failures.length > 0) throw failures[0]
  }

  /** One `rm` of `path`, tried again while a program holds something below it; the last refusal is thrown. */
  private static async removeHeld(fs: TreeRemovalFs, path: string, policy: TreeRemovalHeldPolicy, onHeld: (held: TreeRemovalHeld) => void): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fs.rm(path, TreeRemoval.countedRmOptionsConst)
      } catch (error) {
        const code = ErrnoCode.of(error)
        if (attempt >= policy.attempts || code === null || !TreeRemoval.heldCodesConst.includes(code)) throw error
        const refused = (error as { path?: unknown }).path
        onHeld({ path: typeof refused === 'string' ? refused : path, code, attempt, attempts: policy.attempts, delayMilliseconds: policy.delayMilliseconds })
        await new Promise((resolve) => setTimeout(resolve, policy.delayMilliseconds))
      }
    }
  }

  /**
   * Every directory below `root` and `root` itself, each with the entries that are not directories
   * (files and links) and the number of its child directories. A junction or a symlink counts as one
   * file: the `rm` of its parent unlinks it, and its target is never read. The caller has checked
   * that `root` is no link. At most `parallelConst` reads run at a time; a failed read is thrown once
   * every read in flight has ended, so the fallback `rm` never races the walk.
   */
  private static async walk(fs: TreeRemovalFs, root: string, onProgress: TreeRemovalListener): Promise<WalkedDirectory[]> {
    const directories: WalkedDirectory[] = []
    const slot = TreeRemoval.pool(TreeRemoval.parallelConst)
    let counted = 0
    const visit = async (path: string, parent: WalkedDirectory | null): Promise<void> => {
      const directory: WalkedDirectory = { path, files: 0, pending: 0, parent }
      directories.push(directory)
      const children: string[] = []
      for (const entry of await slot(() => fs.readdir(path, { withFileTypes: true }))) {
        const child = join(path, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) children.push(child)
        else directory.files += 1
      }
      const kinds = await TreeRemoval.settled(children.map((child) => slot(() => TreeRemoval.realDirectory(fs, child))))
      const below = children.filter((_child, index) => kinds[index])
      directory.files += children.length - below.length
      directory.pending = below.length
      counted += directory.files
      onProgress({ phase: 'counting', done: counted, total: null })
      await TreeRemoval.settled(below.map((child) => visit(child, directory)))
    }
    await visit(root, null)
    return directories
  }

  /** As `Promise.all`, but it waits for every promise before it throws the first failure. */
  private static async settled<T>(promises: readonly Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(promises)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
    return results.map((result) => (result as PromiseFulfilledResult<T>).value)
  }

  /** Runs at most `limit` tasks at once; a finished task hands its slot to the next waiting one. */
  private static pool(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0
    const waiting: (() => void)[] = []
    return async (task) => {
      if (active < limit) active += 1
      else await new Promise<void>((resolve) => waiting.push(resolve))
      try {
        return await task()
      } finally {
        const next = waiting.shift()
        if (next === undefined) active -= 1
        else next()
      }
    }
  }

  /** The Dirent and `lstat` must both call it a directory and no link: walking into a junction would count its target's files. */
  private static async realDirectory(fs: TreeRemovalFs, path: string): Promise<boolean> {
    const stat = await fs.lstat(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  }
}
