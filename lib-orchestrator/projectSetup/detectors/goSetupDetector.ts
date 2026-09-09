import { join } from 'node:path'

import type { SetupDetection, SetupDetector } from '../projectSetup.types'
import { SetupPaths } from '../setupPaths'

/**
 * go: modules are the only dependency mechanism left, so `go.mod` is the whole rule and nothing here
 * can be ambiguous.
 *
 * Dormant until the first go project is opened; the trigger and what happens if it never is are
 * registered in `docs/architecture/lib-orchestrator.md`.
 */
export class GoSetupDetector implements SetupDetector {
  readonly familyId = 'go' as const

  private static readonly moduleFileConst = 'go.mod'

  async detect(projectRoot: string): Promise<SetupDetection | null> {
    const module = join(projectRoot, GoSetupDetector.moduleFileConst)
    return await SetupPaths.isFile(module) ? { kind: 'tool', toolId: 'go-mod' } : null
  }
}
