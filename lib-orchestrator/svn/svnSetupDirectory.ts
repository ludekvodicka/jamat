import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface SetupEntry { path: string; hash: string | null; size: number }

export class SvnSetupDirectory {
  static readonly maximumBytes = 500 * 1024 * 1024

  static async save(root: string, saved: string): Promise<SetupEntry[]> {
    const entries = await SvnSetupDirectory.inventory(root)
    for (const entry of entries) {
      const target = join(saved, 'working', entry.path)
      if (entry.hash === null) await mkdir(target, { recursive: true })
      else {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(root, entry.path), target)
        if (await SvnSetupDirectory.hash(target) !== entry.hash) throw new Error(`Setup changed during copy: ${entry.path}`)
      }
    }
    await writeFile(join(saved, 'directory.json'), JSON.stringify(entries), { flag: 'wx' })
    await SvnSetupDirectory.verify(root, entries)
    return entries
  }

  static async remove(root: string, entries: readonly SetupEntry[]): Promise<void> {
    await SvnSetupDirectory.verify(root, entries)
    for (const entry of entries.filter((entry) => entry.hash !== null)) {
      const path = join(root, entry.path)
      if ((await lstat(path)).isSymbolicLink() || await SvnSetupDirectory.hash(path) !== entry.hash)
        throw new Error(`Setup changed before removal: ${entry.path}`)
      await unlink(path)
    }
    for (const entry of entries.filter((entry) => entry.hash === null).sort((a, b) => b.path.length - a.path.length))
      await rmdir(join(root, entry.path))
  }

  private static async verify(root: string, entries: readonly SetupEntry[]): Promise<void> {
    if (JSON.stringify(await SvnSetupDirectory.inventory(root)) !== JSON.stringify(entries)) throw new Error('Setup directory changed after its saved copy')
  }

  private static async inventory(root: string): Promise<SetupEntry[]> {
    const entries: SetupEntry[] = []
    let bytes = 0
    const visit = async (path: string): Promise<void> => {
      const absolute = join(root, path)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Setup directory contains a link: ${path}`)
      if (info.isDirectory()) {
        entries.push({ path, hash: null, size: 0 })
        for (const name of (await readdir(absolute)).sort()) {
          if (name === '.svn' || name === '.git' || name === '.checkpoints') throw new Error(`Setup directory contains repository metadata: ${name}`)
          await visit(join(path, name))
        }
      }
      else if (info.isFile()) {
        bytes += info.size
        if (bytes > SvnSetupDirectory.maximumBytes) throw new Error('Setup preservation exceeds 500 MB')
        entries.push({ path, hash: await SvnSetupDirectory.hash(absolute), size: info.size })
      }
      else throw new Error(`Unsupported setup entry: ${path}`)
    }
    await visit('')
    return entries
  }

  private static async hash(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex') }
}
