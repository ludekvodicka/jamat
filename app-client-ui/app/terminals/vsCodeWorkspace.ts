import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { VsCodeLauncher } from './vsCodeLauncher'

/**
 * VS Code on a project or worktree root: the workspace file its owner versions there, so a product
 * group opens with all its projects and debug configurations, else the folder.
 */
export class VsCodeWorkspace {
  private static readonly suffixConst = '.code-workspace'

  /** The single workspace file at the root; with several, the one named after the owner folder; else the folder. */
  static targetOf(worktreePath: string, ownerName: string, names: readonly string[]): string {
    const files = names.filter((name) => name.endsWith(VsCodeWorkspace.suffixConst))
    if (files.length === 1) return join(worktreePath, files[0])
    const named = files.find((name) => name === `${ownerName}${VsCodeWorkspace.suffixConst}`)
    return named === undefined ? worktreePath : join(worktreePath, named)
  }

  /** A root that cannot be listed opens as the folder, and VS Code says what is wrong with it. */
  static async open(launcher: Pick<typeof VsCodeLauncher, 'open'>, worktreePath: string, ownerName: string): Promise<void> {
    const names = await readdir(worktreePath, { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      () => [],
    )
    launcher.open(VsCodeWorkspace.targetOf(worktreePath, ownerName, names), null)
  }
}
