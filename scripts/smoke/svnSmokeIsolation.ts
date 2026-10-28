import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { PathCompare } from '../../lib-orchestrator/shared/pathCompare.js'

export class SvnSmokeIsolation {
  static async parent(requested: string): Promise<string> {
    const parent = await realpath(resolve(requested))
    for (let current = parent; ; current = dirname(current)) {
      for (const marker of ['.svn', '.git', '.appgroup']) {
        const path = join(current, marker)
        const present = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        })
        if (present)
          throw new Error(`Unsafe SVN smoke test root ${parent}: inherited ${path}. Choose an existing directory outside repositories and project groups, such as the OS temporary directory.`)
      }
      if (dirname(current) === current) return parent
    }
  }

  static async owner(root: string, owner: string): Promise<void> {
    const boundary = await realpath(root), target = await realpath(owner)
    if (!PathCompare.isInside(boundary, target))
      throw new Error(`SVN smoke owner escaped its fixture: ${target} is outside ${boundary}`)
  }
}
