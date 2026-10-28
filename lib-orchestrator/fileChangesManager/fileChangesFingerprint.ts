import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'

import { ErrnoCode } from '../shared/errnoCode'

export class FileChangesFingerprint {
  static async of(path: string): Promise<string> {
    const before = await lstat(path).catch((error: unknown) => {
      if (ErrnoCode.of(error) === 'ENOENT') return null
      throw error
    })
    if (before === null) return 'missing'
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
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error(`${path} changed while its review was being read; reload the files`)
    return `${before.mode}:${content}`
  }
}
