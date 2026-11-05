import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TreeRemoval, type TreeRemovalProgress, type TreeRemovalListener } from '../../lib-orchestrator/shared/treeRemoval'

export class OriginalTreeRemoval {
  static async check(timeoutMilliseconds: number): Promise<void> {
    await OriginalTreeRemoval.checkSmokeTreeRemovalOnce(timeoutMilliseconds)
    const seen: TreeRemovalProgress[] = []
    await OriginalTreeRemoval.checkSmokeTreeRemovalOnce(timeoutMilliseconds, (progress) => seen.push(progress))
    if (!seen.some((progress) => progress.phase === 'deleting' && progress.total !== null && progress.total > 0 && progress.done === progress.total))
      throw new Error(`Smoke tree removal reported no count: ${JSON.stringify(seen.slice(-3))}`)
  }

  private static async checkSmokeTreeRemovalOnce(timeoutMilliseconds: number, onProgress?: TreeRemovalListener): Promise<void> {
    const fs = OriginalTreeRemoval.originalFs()
    const tree = await fs.promises.mkdtemp(join(tmpdir(), 'jamat-v3-smoke-asar-'))
    const outside = await fs.promises.mkdtemp(join(tmpdir(), 'jamat-v3-smoke-junction-'))
    try {
      await fs.promises.writeFile(join(outside, 'kept.txt'), 'kept')
      const resources = join(tree, 'node_modules', 'electron', 'dist', 'resources')
      await fs.promises.mkdir(resources, { recursive: true })
      await fs.promises.copyFile(join(process.resourcesPath, 'default_app.asar'), join(resources, 'default_app.asar'))
      await fs.promises.symlink(outside, join(tree, 'node_modules', 'linked'), 'junction')
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Smoke tree removal of ${tree} did not finish`)),
          timeoutMilliseconds)
      })
      try { await Promise.race([OriginalTreeRemoval.remove(tree, onProgress), deadline]) }
      finally { clearTimeout(timer) }
      if (fs.existsSync(tree))
        throw new Error(`Smoke tree removal left ${tree} behind`)
      if (!fs.existsSync(join(outside, 'kept.txt')))
        throw new Error(`Smoke tree removal followed the junction into ${outside}`)
    }
    finally {
      await fs.promises.rm(outside, TreeRemoval.rmOptionsConst)
    }
  }

  private static originalFs(): typeof import('original-fs') {
    return createRequire(__filename)('original-fs') as typeof import('original-fs')
  }

  static remove(path: string, onProgress?: TreeRemovalListener): Promise<void> {
    return TreeRemoval.over(OriginalTreeRemoval.originalFs().promises)(path, onProgress)
  }
}
