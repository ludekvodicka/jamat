import type { DisplayEntry, ProjectEntry, VirtualFolderDef } from '../projectManagerApi.types'

/**
 * Virtual folders: a display grouping over project names, with no directory behind it. Ported from
 * V1 `core/menu-core/pure.ts` with the semantics untouched - the names on disk were created under
 * these rules, so a stricter or looser match would regroup projects the user already sorted.
 */
export class DisplayGrouping {
  /**
   * The prefix has to end on a word boundary: `temporary` groups `temporaryFoo` but not
   * `temporaryfoo`. A prefix ending in `-` or `_` carries its own boundary, so a plain prefix
   * match is enough there.
   */
  static matchesVirtualPrefix(name: string, prefix: string): boolean {
    if (name.length <= prefix.length || !name.startsWith(prefix)) return false
    const lastPrefixCharacter = prefix[prefix.length - 1]
    if (lastPrefixCharacter === '-' || lastPrefixCharacter === '_') return true
    return DisplayGrouping.isUpperCase(name[prefix.length])
  }

  /** Non-empty virtual folders first, sorted by title, then every project that matched none. */
  static buildDisplayEntries(
    projects: readonly ProjectEntry[],
    virtualFolders: readonly VirtualFolderDef[],
  ): DisplayEntry[] {
    const grouped = new Set<ProjectEntry>()
    const folders: Extract<DisplayEntry, { kind: 'virtualFolder' }>[] = []
    for (const folder of virtualFolders) {
      const children = projects.filter((project) =>
        DisplayGrouping.matchesVirtualPrefix(project.name, folder.prefix))
      for (const child of children) grouped.add(child)
      if (children.length > 0)
        folders.push({ kind: 'virtualFolder', prefix: folder.prefix, title: folder.title, children })
    }
    folders.sort((left, right) => left.title.localeCompare(right.title))
    const loose: DisplayEntry[] = projects
      .filter((project) => !grouped.has(project))
      .map((project) => ({ kind: 'project', project }))
    return [...folders, ...loose]
  }

  /**
   * The new name for a move between virtual folders: drop whichever prefix the name carries now and
   * put the target one on. `null` takes the project out of every virtual folder.
   */
  static applyPrefix(
    name: string,
    virtualFolders: readonly VirtualFolderDef[],
    targetPrefix: string | null,
  ): string {
    const current = DisplayGrouping.currentPrefixOf(name, virtualFolders)
    const base = current === null ? name : name.slice(current.length)
    if (targetPrefix === null || targetPrefix.length === 0) return base
    if (base.length === 0) return targetPrefix
    const lastCharacter = targetPrefix[targetPrefix.length - 1]
    if (lastCharacter === '-' || lastCharacter === '_') return targetPrefix + base
    return targetPrefix + base[0].toUpperCase() + base.slice(1)
  }

  /** The first folder that claims the name, matching how `buildDisplayEntries` assigns it. */
  private static currentPrefixOf(
    name: string,
    virtualFolders: readonly VirtualFolderDef[],
  ): string | null {
    for (const folder of virtualFolders)
      if (DisplayGrouping.matchesVirtualPrefix(name, folder.prefix)) return folder.prefix
    return null
  }

  private static isUpperCase(character: string): boolean {
    return character.length === 1 && character >= 'A' && character <= 'Z'
  }
}
