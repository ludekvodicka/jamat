import { dirname, join } from 'node:path'

import type { RemoteLauncherRecipe } from './remoteLauncherConfig'
import type { RemoteLauncherProcess } from './remoteLauncherProcess'

export function launcherProcess(recipe: RemoteLauncherRecipe, node: string): RemoteLauncherProcess {
  switch (recipe.kind) {
    case 'executable': return { command: recipe.path, args: [], cwd: dirname(recipe.path),
      windowsVerbatimArguments: false, completion: 'spawn', readinessTimeoutMs: 60_000,
      requiredFiles: [], requireRunning: false }
    case 'source': {
      const args = [join(recipe.repositoryRoot, 'node_modules/tsx/dist/cli.mjs'),
        join(recipe.repositoryRoot, 'scripts/release/start-packaged-client.ts')]
      return { command: node, args, cwd: recipe.repositoryRoot, windowsVerbatimArguments: false,
        completion: 'exit-zero', readinessTimeoutMs: 60_000, requiredFiles: args, requireRunning: false }
    }
    case 'development': {
      const cwd = join(recipe.repositoryRoot, 'app-client-ui')
      const entry = join(cwd, 'node_modules/electron-vite/bin/electron-vite.js')
      return { command: node, args: [entry, 'dev'], cwd, windowsVerbatimArguments: false,
        completion: 'spawn', readinessTimeoutMs: 150_000, requireRunning: true,
        requiredFiles: [entry, join(cwd, 'package.json'), join(cwd, 'electron.vite.config.ts'),
          join(recipe.repositoryRoot, 'app-host/start.ts')] }
    }
    case 'command': return { ...recipe, completion: 'exit-zero', readinessTimeoutMs: 60_000,
      requiredFiles: [], requireRunning: false }
    case 'detached-command': return { ...recipe, completion: 'spawn', readinessTimeoutMs: 150_000,
      requiredFiles: [], requireRunning: true }
    default: throw new Error('Unknown launch recipe')
  }
}
