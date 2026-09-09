import { join } from 'node:path'

import type { SetupDetection, SetupDetector } from '../projectSetup.types'
import { SetupPaths } from '../setupPaths'

/**
 * rust: cargo is the only installer there is, so `Cargo.toml` is the whole rule and nothing here can
 * be ambiguous.
 *
 * Dormant until the first rust project is opened; the trigger and what happens if it never is are
 * registered in `docs/architecture/lib-orchestrator.md`.
 */
export class RustSetupDetector implements SetupDetector {
  readonly familyId = 'rust' as const

  private static readonly manifestFileConst = 'Cargo.toml'

  async detect(projectRoot: string): Promise<SetupDetection | null> {
    const manifest = join(projectRoot, RustSetupDetector.manifestFileConst)
    return await SetupPaths.isFile(manifest) ? { kind: 'tool', toolId: 'rust-cargo' } : null
  }
}
