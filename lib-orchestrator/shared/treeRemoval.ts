import { rm } from 'node:fs/promises'

/** Deletes a file or a whole directory tree; a path that is already gone is no failure. */
export type TreeRemove = (path: string) => Promise<void>

/**
 * How this library deletes a tree the user's tools filled, such as a worktree with its
 * `node_modules`.
 *
 * Node's own `rm` is right in every plain Node process. It is wrong inside Electron, whose `fs`
 * reads any `*.asar` file as an archive directory: a recursive `rm` opens the archive, fails its
 * `rmdir` with EBUSY, and the process keeps the file open until it exits, so not even Explorer can
 * delete it. An Electron composer therefore hands in a remover over `original-fs`.
 */
export class TreeRemoval {
  /** Windows keeps a just-closed file locked for a moment, which is what the retries are for. */
  static readonly rmOptionsConst = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as const
  static readonly node: TreeRemove = (path) => rm(path, TreeRemoval.rmOptionsConst)
}
