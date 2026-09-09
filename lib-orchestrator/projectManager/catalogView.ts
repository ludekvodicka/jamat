import { ConfigStore } from '../configStore/configStore'
import type { CategorySummary } from './catalog/catalog.types'
import { CatalogStore } from './catalog/catalogStore'
import { ProjectMatcher } from './catalog/projectMatcher'
import type { ProjectBinding } from './projectManagerApi.types'

/** One look at the catalog: the categories that were read, and binding against exactly those. */
export interface CatalogReading {
  readonly categories: readonly CategorySummary[]
  bind(cwd: string, worktreeRepositoryRoot?: string): ProjectBinding
}

/**
 * The subsystem's declared READ surface, on its root beside `projectManagerApi.types` - the wire
 * file is the precedent for a second surface that is not the facade. The facade is async and it
 * writes; this is synchronous and cannot, which is what the session manager's `compose()` needs.
 *
 * It exists so a second subsystem stops importing `catalog/` internals. `catalog/` itself stays
 * where it is: the promotion trigger registered in `docs/architecture/lib-orchestrator.md` asks for
 * a third consumer or friction between the two readers, and neither has arrived.
 */
export class CatalogView {
  private constructor(private readonly store: CatalogStore) {}

  /** Read-only by construction: with no snapshots directory the store refuses every save. */
  static load(configDir: string, options?: { report?: (message: string) => void }): CatalogView {
    // No `legacySnapshotSection` here on purpose: with no snapshots directory this store refuses
    // every save, so it never rotates a ring and has nothing to claim. Whoever builds the WRITING
    // store says whose the key-less names are - `appHub.ts` and `scripts/smoke/project-manager.ts`.
    return new CatalogView(new CatalogStore(ConfigStore.load(configDir, {
      report: options?.report,
    })))
  }

  /**
   * One read per pass, and that is the point of the method. `ConfigStore` re-reads whenever the
   * file's mtime moves, so asking it twice while one snapshot is being composed can answer from two
   * different documents - and the snapshot's category list would then disagree with the bindings
   * standing beside it.
   */
  read(): CatalogReading {
    const categories = this.store.categories()
    const matcher = new ProjectMatcher(categories)
    return {
      categories,
      bind: (cwd, worktreeRepositoryRoot) => matcher.bind(cwd, worktreeRepositoryRoot),
    }
  }
}
