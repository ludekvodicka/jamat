import type { SessionAgentId } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { VirtualFolderDef } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { LauncherBinding } from './launcherBinding'

/**
 * The words more than one screen of this card says. It sits at the launcher root for the same reason
 * `launcherBinding.ts` does: what the screens hand each other belongs beside them, not inside one of
 * them. Two screens naming an agent differently is the kind of drift nobody notices until a
 * screenshot puts them side by side.
 */
export class LauncherLabels {
  static agentLabelOf(agentId: SessionAgentId): string {
    if (agentId === 'claude') return 'Claude'
    else if (agentId === 'codex') return 'Codex'
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /** The title if the provider recorded one, else the words the session was opened with. */
  static summaryLabelOf(summary: { title: string | null; firstUserMessage: string | null }): string {
    return summary.title ?? summary.firstUserMessage ?? 'Untitled session'
  }

  /**
   * What a project row reads as. Its directory name at the root of a category, and inside a virtual
   * folder that name without the prefix that named the folder - `houseBazen` shows as `Bazen`, as it
   * did in V1, because the prefix is the folder and the folder is already the line above.
   *
   * `ProjectEntry.name` is never touched: it is the directory, and the summaries, the cursor's
   * memory of a created name and every operation are keyed by it. Only what is drawn is shortened.
   *
   * Only a name the folder actually HOLDS is shortened, which `startsWith` alone does not decide:
   * search is flat over the whole category, so a row drawn while the cursor stands in `house` can be
   * `housebazen`, a project the grouping deliberately left outside it. Drawn as `bazen` it read as a
   * member of a folder that refused it, and type-to-jump followed that made-up name.
   */
  static projectLabelOf(name: string, virtualFolderPrefix: string | null): string {
    if (virtualFolderPrefix === null || !LauncherLabels.matchesVirtualPrefix(name, virtualFolderPrefix))
      return name
    return name.slice(virtualFolderPrefix.length)
  }

  /**
   * A knowing second copy of `DisplayGrouping.matchesVirtualPrefix`: the renderer may only
   * `import type` from `lib-orchestrator`, so the rule that decides membership is spelled again here
   * rather than imported. If the two ever drift apart, this one only decides how much of a directory
   * name is DRAWN - the grouping, the moves and the renames all stay the library's - so a row reads
   * as its whole name where the library would have shortened it, and nothing is regrouped by it.
   */
  private static matchesVirtualPrefix(name: string, prefix: string): boolean {
    if (name.length <= prefix.length || !name.startsWith(prefix)) return false
    const lastPrefixCharacter = prefix[prefix.length - 1]
    if (lastPrefixCharacter === '-' || lastPrefixCharacter === '_') return true
    const nextCharacter = name[prefix.length]
    return nextCharacter >= 'A' && nextCharacter <= 'Z'
  }

  /**
   * `NodeJs › House projects`, or the root alone when the cursor is not inside a folder.
   * A folder the config no longer names still reads as the root rather than as nothing.
   *
   * Two folders sharing one prefix are one folder to this: the first that carries it is what names
   * the line. Nothing here can tell them apart honestly - the cursor holds a prefix and not a folder -
   * and the configuration tab already warns about the pair rather than refusing it.
   */
  static breadcrumbOf(
    categoryLabel: string,
    folders: readonly VirtualFolderDef[],
    virtualFolderPrefix: string | null,
  ): string {
    const folder = LauncherLabels.folderTitleOf(folders, virtualFolderPrefix)
    return folder === null ? categoryLabel : `${categoryLabel} › ${folder}`
  }

  /**
   * The innermost of the same two: the folder alone when there is one, because inside a folder the
   * root is what the folder is in and not where anything lands. Said by the strip that asks for a new
   * project's name, which sits at the bottom of the card with neither the tab row nor the breadcrumb
   * anywhere near it.
   */
  static placeOf(
    categoryLabel: string,
    folders: readonly VirtualFolderDef[],
    virtualFolderPrefix: string | null,
  ): string {
    return LauncherLabels.folderTitleOf(folders, virtualFolderPrefix) ?? categoryLabel
  }

  private static folderTitleOf(
    folders: readonly VirtualFolderDef[],
    virtualFolderPrefix: string | null,
  ): string | null {
    if (virtualFolderPrefix === null)
      return null
    return folders.find((candidate) => candidate.prefix === virtualFolderPrefix)?.title ?? null
  }

  static whereOf(binding: LauncherBinding): string {
    if (binding.mode === 'project')
      return binding.projectPath
    else if (binding.mode === 'adHoc')
      return binding.path
    else
      throw new Error(`Unknown launcher binding: ${JSON.stringify(binding)}`)
  }
}
