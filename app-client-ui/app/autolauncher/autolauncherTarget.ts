import { isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

import type { AutolauncherSnapshot, AutolauncherTargetView } from '../../shared/autolauncher'
import { RemoteLauncherConfig } from '../../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import { launcherProcess } from '../../../lib-orchestrator/remoteControl/remoteLauncherRecipe'
import { inspectLauncherProcess } from '../../../lib-orchestrator/remoteControl/remoteLauncherProcess'

export class AutolauncherTarget {
  static async inspect(value: unknown, node: string): Promise<AutolauncherTargetView> {
    let recipe
    try { recipe = RemoteLauncherConfig.recipe(value) }
    catch { return { recipe: null, process: null, availability: { state: 'invalid', path: 'Launch recipe' }, warning: null } }
    const process = launcherProcess(recipe, node)
    const paths = [process.command, process.cwd, ...process.requiredFiles]
    const temporary = paths.find(path => {
      const fromTemp = relative(tmpdir(), path)
      return fromTemp === '' || !isAbsolute(fromTemp) && fromTemp !== '..' && !fromTemp.startsWith(`..${sep}`)
        || /(?:^|[/\\])(?:temp|scratchpad|win-unpacked|linux-unpacked|candidate[^/\\]*)(?:[/\\]|$)/i.test(path)
    })
    return { recipe, process, availability: await inspectLauncherProcess(process),
      warning: temporary ? `This target uses a temporary or unpacked location: ${temporary}. It may disappear. Choose a stable checkout or explicitly keep this location.` : null }
  }

  static fromRunning(target: AutolauncherSnapshot['target']): unknown {
    if (target.mode === 'source') return { kind: 'source', repositoryRoot: target.path }
    else if (target.mode === 'executable') return { kind: 'executable', path: target.path }
    else throw new Error('Unknown launcher mode')
  }

  static recipe(packaged: boolean, applicationRoot: string, executable: string,
    sourceCheckout: string | undefined): Pick<AutolauncherSnapshot['target'], 'mode' | 'path'> {
    if (!packaged) return { mode: 'source', path: applicationRoot }
    if (sourceCheckout && isAbsolute(sourceCheckout)) {
      const path = relative(join(sourceCheckout, 'app-client-ui', 'dist', 'local-releases'), executable)
      // A terminal may inherit the hint; only a package produced by that checkout belongs to it.
      if (path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
        return { mode: 'source', path: sourceCheckout }
    }
    return { mode: 'executable', path: executable }
  }
}
