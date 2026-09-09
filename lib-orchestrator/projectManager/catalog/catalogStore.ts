import type { ConfigStore } from '../../configStore/configStore'
import type { ConfigOpRefusal, ConfigOpResult } from '../../configStore/configStore.types'
import { PathCompare } from '../../shared/pathCompare'
import type {
  CatalogCategoryDto,
  ProjectsOpErrorCode,
  ProjectsOpResult,
} from '../projectManagerApi.types'
import type { CategorySummary, RuntimeCategory } from './catalog.types'
import { CatalogSection } from './catalogSection'

/**
 * The project catalog: the owner of the `categories` section of `<configDir>/config.json`.
 *
 * It owns the value of that one key and nothing else. The document around it - the envelope, the
 * unknown top-level keys, every foreign section, the latch and the snapshot ring - belongs to
 * `ConfigStore`, so a save here replaces the roots and leaves everything standing beside them
 * exactly as the file spells it.
 *
 * The wire codes are this class's own translation. `catalog-latched` and `invalid-config` are what
 * the settings tab has always been told, `catalog-damaged` is the third state the section registry
 * created, and the store's file-level vocabulary stops here.
 *
 * The two readers are answered differently on purpose. The tree and the launcher read through
 * `categories()`, which is lenient and always answers - a window has to draw something whatever the
 * file says. The EDITOR reads through `getCategories()`, which refuses: showing it an empty list
 * would tell the user the file holds no roots, and their next act would be to add one and save over
 * the roots it does hold.
 */
export class CatalogStore {
  constructor(private readonly store: ConfigStore) {}

  /** Synchronous by contract: the tree builds its roots before it has anywhere to await. */
  categories(): readonly CategorySummary[] {
    return this.read().map(({ id, label, path }) => ({ id, label, path }))
  }

  /** A copy: the caller edits what it gets and hands it back to `saveCategories`, and until it does
   *  the store must keep answering with what is on disk. */
  async getCategories(): Promise<ProjectsOpResult<CatalogCategoryDto[]>> {
    const damage = this.store.sectionDamage(CatalogSection.spec)
    if (damage) return CatalogStore.refused(damage)
    return { ok: true, value: structuredClone(this.read()) }
  }

  /**
   * Last-write-wins within the section: what the caller hands over replaces the roots, unknown keys
   * inside a category and all. The guards are the ones that do not depend on a revision - a latched
   * file is never overwritten, an invalid list is refused rather than stored, and the store copies
   * the previous file aside first.
   */
  async saveCategories(categories: readonly CatalogCategoryDto[]): Promise<ProjectsOpResult> {
    // Copied because the section spec is typed on a mutable list, which is the store's business
    // rather than the caller's: nothing from the wire to here has any reason to be mutable.
    return CatalogStore.onWire(this.store.saveSection(CatalogSection.spec, [...categories]))
  }

  runtimeCategory(categoryId: string): RuntimeCategory | null {
    const category = this.read().find((entry) => entry.id === categoryId)
    return category ? CatalogStore.toRuntimeCategory(category) : null
  }

  runtimeCategories(): RuntimeCategory[] {
    return this.read().map(CatalogStore.toRuntimeCategory)
  }

  private read(): CatalogCategoryDto[] {
    return this.store.readSection(CatalogSection.spec)
  }

  private static toRuntimeCategory(category: CatalogCategoryDto): RuntimeCategory {
    return {
      id: category.id,
      label: category.label,
      path: category.path,
      comparablePath: PathCompare.comparable(category.path),
      hiddenFolders: new Set(category.hiddenFolders ?? []),
      flattenFolders: new Set(category.flattenFolders ?? []),
      virtualFolders: category.virtualFolders ?? [],
      afterCreate: category.afterCreate ?? null,
    }
  }

  private static onWire(result: ConfigOpResult): ProjectsOpResult {
    if (result.ok) return { ok: true, value: undefined }
    return CatalogStore.refused(result)
  }

  /** The refusal's own words travel as they are; only the code is translated. */
  private static refused(
    refusal: ConfigOpRefusal,
  ): { ok: false; code: ProjectsOpErrorCode; detail: string } {
    if (refusal.code === 'config-latched')
      return { ok: false, code: 'catalog-latched', detail: refusal.detail }
    else if (refusal.code === 'section-damaged')
      return { ok: false, code: 'catalog-damaged', detail: refusal.detail }
    else if (refusal.code === 'invalid-section')
      return { ok: false, code: 'invalid-config', detail: refusal.detail }
    else
      throw new Error(`Unknown config store refusal: ${JSON.stringify(refusal)}`)
  }
}
