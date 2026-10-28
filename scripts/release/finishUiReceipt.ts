import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class FinishUiReceipt {
  static readonly relativePath = '.aidocs/temp/finish-ui-receipt.json'
  static async hash(root: string): Promise<string> {
    const hash = createHash('sha256').update('finish-ui-v3:svn-matrices:externals\0')
    const visiting = new Set<string>()
    const visit = async (path: string): Promise<void> => {
      const absolute = join(root, path), info = await stat(absolute)
      const physical = await realpath(absolute)
      if (visiting.has(physical)) throw new Error(`Cyclic Finish receipt input: ${path}`)
      visiting.add(physical)
      if (info.isDirectory()) {
        for (const name of (await readdir(absolute)).sort())
          if (!['node_modules', '.svn', '.git', '.checkpoints', '.aidocs'].includes(name)
            && !(path.split('/').length === 1 && ['out', 'dist'].includes(name))) await visit(`${path}/${name}`)
      }
      else if (info.isFile()) hash.update(path).update('\0').update(await readFile(absolute)).update('\0')
      else throw new Error(`Unsupported Finish receipt input: ${path}`)
      visiting.delete(physical)
    }
    for (const path of ['lib-orchestrator', 'app-client-ui', 'app-client-cli', 'app-host', 'app-codex', 'mdext-renderer',
      'scripts', 'configs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']) await visit(path)
    return hash.digest('hex')
  }
  static async save(root: string, tested: string, svnMatrices = false): Promise<void> {
    if (await this.hash(root) !== tested) throw new Error('Finish sources changed during acceptance; run pnpm smoke:worktrees-acceptance again')
    const file = join(root, this.relativePath)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 3, externals: true, svnMatrices, hash: tested, passedAt: new Date().toISOString() }) + '\n', { flush: true })
  }
  static async require(root: string): Promise<void> {
    try {
      const receipt = JSON.parse(await readFile(join(root, this.relativePath), 'utf8'))
      if (receipt.version === 3 && receipt.externals === true && receipt.svnMatrices === true
        && receipt.hash === await this.hash(root) && typeof receipt.passedAt === 'string') return
    } catch {}
    throw new Error('Run pnpm smoke:worktrees-acceptance first (SVN matrices and Finish UI --externals)')
  }
}
