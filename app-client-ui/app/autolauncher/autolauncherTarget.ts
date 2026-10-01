import { isAbsolute, join, relative, sep } from 'node:path'

import type { AutolauncherSnapshot } from '../../shared/autolauncher'

export class AutolauncherTarget {
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
