import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandRunner } from '../shared/commandInvoker.types'

export class SvnNodeContent {
  static async exportedFiles(svn: CommandRunner, cwd: string, files: readonly { path: string; url: string }[], revision: number): Promise<Map<string, string>> {
    const hashes = new Map<string, string>()
    const groups = new Map<string, typeof files[number][]>()
    for (const file of files) {
      const parent = file.url.slice(0, file.url.lastIndexOf('/'))
      groups.set(parent, [...groups.get(parent) ?? [], file])
    }
    for (const [parent, members] of groups) {
      if (members.length === 1) {
        hashes.set(members[0].path, await this.exported(svn, cwd, `${members[0].url}@${revision}`, revision))
        continue
      }
      const directory = await mkdtemp(join(tmpdir(), 'jamat-svn-content-'))
      const snapshot = join(directory, 'content')
      try {
        const result = await svn.run(cwd, ['export', '--non-interactive', '--ignore-externals', '--ignore-keywords', '--native-eol', 'LF',
          '--depth', 'files', '-r', String(revision), '--', `${parent}@${revision}`, snapshot])
        if (result.code !== 0 || result.failure !== null) throw new Error(result.stderr || `SVN content export failed: ${result.failure}`)
        for (const file of members) {
          const leaf = decodeURIComponent(file.url.slice(parent.length + 1))
          if (!leaf || leaf === '.' || leaf === '..' || /[\\/]/.test(leaf)) throw new Error(`Invalid publication filename: ${file.path}`)
          hashes.set(file.path, await this.hash(join(snapshot, leaf)))
        }
      } finally { await rm(snapshot, { recursive: true, force: true }); await rmdir(directory) }
    }
    return hashes
  }

  static async hash(file: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex')
  }

  static async exported(svn: CommandRunner, cwd: string, target: string, revision?: number | 'BASE', workingTranslation = false): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'jamat-svn-content-'))
    const file = join(directory, 'content')
    try {
      const result = await svn.run(cwd, ['export', '--non-interactive', ...workingTranslation ? [] : ['--ignore-keywords', '--native-eol', 'LF'],
        ...(revision === undefined ? [] : ['-r', String(revision)]), '--', target, file])
      if (result.code !== 0 || result.failure !== null) throw new Error(`Cannot read SVN content for ${target}: ${result.stderr || result.failure}`)
      return await SvnNodeContent.hash(file)
    } finally {
      await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      await rmdir(directory)
    }
  }
}
