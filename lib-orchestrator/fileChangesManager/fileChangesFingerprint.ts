import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'

import { ErrnoCode } from '../shared/errnoCode'

export class FileChangesFingerprint {
  private static readonly maxCacheEntriesConst = 10_000
  private static readonly cache = new Map<string, { key: string; fingerprint: string }>()

  static async of(path: string): Promise<string> {
    const before = await lstat(path).catch((error: unknown) => {
      if (ErrnoCode.of(error) === 'ENOENT') return null
      throw error
    })
    if (before === null) {
      FileChangesFingerprint.cache.delete(path)
      return 'missing'
    }
    const statKey = `${before.ino}:${before.size}:${before.mode}:${before.mtimeMs}:${before.ctimeMs}`
    const cached = FileChangesFingerprint.cache.get(path)
    if (cached !== undefined && cached.key === statKey) {
      FileChangesFingerprint.cache.delete(path)
      FileChangesFingerprint.cache.set(path, cached)
      return cached.fingerprint
    }
    let content: string
    if (before.isSymbolicLink()) content = `link:${await readlink(path)}`
    else if (before.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      content = `file:${hash.digest('hex')}`
    }
    else if (before.isDirectory()) content = 'directory'
    else throw new Error(`Cannot review this filesystem node: ${path}`)
    const after = await lstat(path)
    if (before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      FileChangesFingerprint.cache.delete(path)
      throw new Error(`${path} changed while its review was being read; reload the files`)
    }
    const fingerprint = `${before.mode}:${content}`
    FileChangesFingerprint.cache.delete(path)
    FileChangesFingerprint.cache.set(path, { key: statKey, fingerprint })
    while (FileChangesFingerprint.cache.size > FileChangesFingerprint.maxCacheEntriesConst)
      FileChangesFingerprint.cache.delete(FileChangesFingerprint.cache.keys().next().value!)
    return fingerprint
  }

  static clearCache(): void {
    FileChangesFingerprint.cache.clear()
  }
}
