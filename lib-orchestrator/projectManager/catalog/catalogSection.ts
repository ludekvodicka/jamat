import { JsonShape } from '../../shared/jsonShape'
import type { ConfigSectionSpec } from '../../configStore/configStore.types'
import type {
  CatalogCategoryDto,
} from '../projectManagerApi.types'

/**
 * The rules of the `categories` section, and nothing about the file it sits in.
 *
 * Reads are lenient and writes are strict, the same asymmetry `ClientStateStore` uses: refusing to
 * start over one malformed category would be worse than dropping it, while coercing a bad write
 * would quietly replace what the user meant to store. A dropped category is said out loud, because
 * a root that silently stopped existing is a launcher with a tab missing and no reason given.
 *
 * The coercion is total by the section contract: a `categories` key that is not a list is this
 * owner's problem alone, so it reads as no roots and leaves the rest of the file readable.
 *
 * The same value is DAMAGED, and that is the other half of the same decision. Reading it as no roots
 * lets the launcher draw; writing no roots back over it would delete a hand-edit the user could still
 * fix in a text editor, and the empty list the coercion handed out is the app's fallback rather than
 * anything the file says. So this owner is held off its own key until the value is repaired, while
 * every foreign section saves straight past it.
 */
export class CatalogSection {
  static readonly spec: ConfigSectionSpec<CatalogCategoryDto[]> = {
    key: 'categories',
    coerce: (value, report) => CatalogSection.coerceCategories(value, report),
    // An absent key is a fresh machine, not damage. A list holding an unusable entry is not damage
    // either: the entry is dropped aloud and the roots beside it are exactly what the file says.
    damaged: (value) => value !== undefined && !Array.isArray(value),
    validate: (value) => CatalogSection.validateCategories(value),
  }

  private static coerceCategories(
    value: unknown,
    report: (message: string) => void,
  ): CatalogCategoryDto[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      report('The categories of config.json are not a list; reading the catalog as empty')
      return []
    }
    const seen = new Set<string>()
    const categories: CatalogCategoryDto[] = []
    for (const candidate of value) {
      const reason = CatalogSection.categoryProblem(candidate, seen)
      if (reason) {
        report(`The catalog in config.json is dropping a category (${reason})`)
        continue
      }
      const category = candidate as CatalogCategoryDto
      seen.add(category.id)
      categories.push(category)
    }
    return categories
  }

  private static validateCategories(value: CatalogCategoryDto[]): string | null {
    if (!Array.isArray(value)) return 'categories must be an array'
    const seen = new Set<string>()
    for (const candidate of value) {
      const reason = CatalogSection.categoryProblem(candidate, seen)
      if (reason) return reason
      seen.add((candidate as CatalogCategoryDto).id)
    }
    return null
  }

  private static categoryProblem(candidate: unknown, seen: ReadonlySet<string>): string | null {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return 'expected an object'
    const category = candidate as Partial<CatalogCategoryDto>
    if (!CatalogSection.isFilledString(category.id)) return 'id must be a non-empty string'
    if (!CatalogSection.isFilledString(category.label))
      return `category ${category.id}: label must be a non-empty string`
    if (!CatalogSection.isFilledString(category.path))
      return `category ${category.id}: path must be a non-empty string`
    if (seen.has(category.id)) return `duplicate category id ${category.id}`
    const names = CatalogSection.nameListProblem(category.hiddenFolders, 'hiddenFolders')
      ?? CatalogSection.nameListProblem(category.flattenFolders, 'flattenFolders')
    if (names) return `category ${category.id}: ${names}`
    const virtualFolders = CatalogSection.virtualFoldersProblem(category.virtualFolders)
    if (virtualFolders) return `category ${category.id}: ${virtualFolders}`
    const afterCreate = CatalogSection.afterCreateProblem(category.afterCreate)
    if (afterCreate) return `category ${category.id}: ${afterCreate}`
    return null
  }

  private static nameListProblem(value: unknown, field: string): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value) || value.some((name) => !CatalogSection.isFilledString(name)))
      return `${field} must be an array of non-empty strings`
    return null
  }

  /*
   * `unknown`, not the DTO. This runs over a hand-edited file, so the parameter typed as the shape
   * being checked FOR made every line below read as dead code - the check answering itself, which is
   * the one thing a validator must not do.
   */
  private static virtualFoldersProblem(value: unknown): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value)) return 'virtualFolders must be an array'
    for (const entry of value) {
      const folder = JsonShape.record(entry)
      if (folder === null) return 'each virtualFolder must be an object'
      if (!CatalogSection.isFilledString(folder.prefix) || !CatalogSection.isFilledString(folder.title))
        return 'each virtualFolder needs a non-empty prefix and title'
    }
    return null
  }

  /** `unknown` for the same reason as the folders above. */
  private static afterCreateProblem(value: unknown): string | null {
    if (value === undefined) return null
    const hook = JsonShape.record(value)
    if (hook === null) return 'afterCreate must be an object'
    if (!CatalogSection.isFilledString(hook.command))
      return 'afterCreate.command must be a non-empty string'
    if (hook.args !== undefined
      && (!Array.isArray(hook.args) || hook.args.some((argument: unknown) => typeof argument !== 'string')))
      return 'afterCreate.args must be an array of strings'
    return null
  }

  private static isFilledString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }
}
