import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import type { SetupDetection, SetupDetector, SetupToolId } from '../projectSetup.types'
import { SetupPaths } from '../setupPaths'

/**
 * node: the manifest decides, then the lockfile, then the workspace the project sits in, and nothing
 * else guesses.
 *
 * The order is what makes it deterministic. A `packageManager` field is the project saying it out
 * loud, so it wins even against a lockfile that disagrees - the lockfile may be an old one somebody
 * forgot to delete. Without the field, exactly one lockfile is an answer and two are not: installing
 * with the wrong one writes a second lockfile into the worktree and resolves a different tree than
 * the project's own.
 *
 * The workspace file is read before the npm fallback rather than after a tool was already chosen. A
 * member of a pnpm workspace carries neither the field nor a lockfile - both sit at the workspace
 * root - so a rule that only asks about it once pnpm has been decided some other way answers `npm`
 * for every real workspace member, which is the very harm the rules above exist to prevent.
 *
 * **A workspace is not always a `pnpm-workspace.yaml`.** npm and yarn declare theirs as a
 * `workspaces` field in the root `package.json`, so their members carry no marker of their own
 * either, and asking only about the pnpm file answered `npm` in the member's own directory for every
 * one of them - the same bug in a second family. Both markers are walked for, and which tool installs
 * a manifest workspace is read at ITS root, by these same rules.
 *
 * What is deliberately not done, for either family, is matching the member against the workspace's
 * globs: a directory under a workspace root is taken to belong to it. Reading the globs would answer
 * a question nobody has asked yet, and answering it for one family and not the other would be worse
 * than answering it for neither.
 */
export class NodeSetupDetector implements SetupDetector {
  readonly familyId = 'node' as const

  private static readonly manifestFileConst = 'package.json'
  private static readonly workspaceFileConst = 'pnpm-workspace.yaml'
  private static readonly lockfilesConst: readonly { file: string; toolId: SetupToolId }[] = [
    { file: 'pnpm-lock.yaml', toolId: 'node-pnpm' },
    { file: 'package-lock.json', toolId: 'node-npm' },
    { file: 'yarn.lock', toolId: 'node-yarn' },
  ]
  /** The corepack spelling is `<name>@<version>`; only the name in front of it is read. */
  private static readonly packageManagersConst: readonly { name: string; toolId: SetupToolId }[] = [
    { name: 'pnpm', toolId: 'node-pnpm' },
    { name: 'npm', toolId: 'node-npm' },
    { name: 'yarn', toolId: 'node-yarn' },
  ]

  async detect(projectRoot: string, repositoryRoot: string): Promise<SetupDetection | null> {
    const manifestFile = join(projectRoot, NodeSetupDetector.manifestFileConst)
    if (!await SetupPaths.isFile(manifestFile)) return null
    let manifest: unknown
    try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')) }
    catch (error) {
      // A manifest that is there but unreadable is not "no node project here": saying so would send
      // the resolution off to another family while npm would have failed on the very same file.
      return {
        kind: 'ambiguous',
        reason: `${manifestFile} could not be read (${ErrorText.of(error)});`
          + ' repair it or add a .worktree.json with a "setup" array',
      }
    }
    const field = (manifest as { packageManager?: unknown } | null)?.packageManager
    const declared = typeof field === 'string' ? NodeSetupDetector.toolOfName(field) : null
    if (typeof field === 'string' && declared === null)
      return {
        kind: 'ambiguous',
        reason: `"packageManager": ${JSON.stringify(field)} in ${manifestFile} names a package`
          + ' manager this build cannot install with; add a .worktree.json with a "setup" array',
      }
    const locks = await NodeSetupDetector.lockfilesOf(projectRoot)
    if (declared === null && locks.length > 1)
      return {
        kind: 'ambiguous',
        reason: `${locks.map((lock) => lock.file).join(' + ')} without a "packageManager" field;`
          + ' add the field or a .worktree.json with a "setup" array',
      }
    const localLock = locks.length === 1 ? locks[0] : null
    const above = await NodeSetupDetector.workspaceAbove(projectRoot, repositoryRoot)
    if (declared === null && above !== null && above.toolId === null)
      return {
        kind: 'ambiguous',
        reason: `the workspace rooted at ${above.marker} does not say which package manager installs`
          + ' it; declare a "packageManager" field there or add a .worktree.json with a "setup" array',
      }
    if (declared === null && above !== null
      && localLock !== null && localLock.toolId !== above.toolId)
      return {
        kind: 'ambiguous',
        reason: `${localLock.file} sits inside the workspace rooted at ${above.marker}, and nothing`
          + ' declares which of the two is right; leave one of them or add a .worktree.json with a'
          + ' "setup" array',
      }
    // No lockfile, no field and no workspace above is npm by convention rather than by guess: npm
    // ships with Node, so it is the one tool the project is certain to have.
    const toolId = declared ?? localLock?.toolId ?? above?.toolId ?? 'node-npm'
    if (toolId !== 'node-npm' && toolId !== 'node-yarn' && toolId !== 'node-pnpm')
      // A tool added to the family without an answer to the workspace question fails here rather
      // than quietly installing from the wrong directory.
      throw new Error(`Unknown node package manager: ${JSON.stringify(toolId)}`)
    // Every one of the three installs a workspace from its root. A project whose own field or
    // lockfile answered against the workspace is not in it for this purpose: it was either refused
    // above, or it declared itself out, and it installs where it stands.
    if (above === null || above.toolId !== toolId) return { kind: 'tool', toolId }
    const installCwd = SetupPaths.relativeOf(repositoryRoot, above.root)
    // The walk stops at the repository root, so a workspace above that is outside it does not exist.
    if (installCwd === null)
      throw new Error(`The workspace root ${above.root} is not inside ${repositoryRoot}`)
    return { kind: 'tool', toolId, installCwd }
  }

  private static toolOfName(field: string): SetupToolId | null {
    const name = field.split('@')[0].trim()
    return NodeSetupDetector.packageManagersConst.find((entry) => entry.name === name)?.toolId ?? null
  }

  private static async lockfilesOf(
    projectRoot: string,
  ): Promise<{ file: string; toolId: SetupToolId }[]> {
    const found: { file: string; toolId: SetupToolId }[] = []
    for (const lock of NodeSetupDetector.lockfilesConst)
      if (await SetupPaths.isFile(join(projectRoot, lock.file))) found.push(lock)
    return found
  }

  /**
   * A workspace installs its members from its own root, so a package inside one has to be installed
   * from above itself. The walk stops at the repository root: a workspace outside the repository
   * belongs to a tree this worktree will never contain.
   *
   * The nearest marker wins, and `pnpm-workspace.yaml` wins over a `workspaces` field in the same
   * directory: a repository carrying both is a pnpm repository whose manifest still says what npm
   * would have done.
   */
  private static async workspaceAbove(
    projectRoot: string,
    repositoryRoot: string,
  ): Promise<WorkspaceAbove | null> {
    const root = PathCompare.comparable(repositoryRoot)
    let current = resolve(projectRoot)
    for (;;) {
      const found = await NodeSetupDetector.workspaceAt(current)
      if (found) return found
      const parent = dirname(current)
      if (PathCompare.comparable(current) === root || parent === current) return null
      current = parent
    }
  }

  private static async workspaceAt(directory: string): Promise<WorkspaceAbove | null> {
    const pnpmFile = join(directory, NodeSetupDetector.workspaceFileConst)
    if (await SetupPaths.isFile(pnpmFile))
      return { root: directory, marker: pnpmFile, toolId: 'node-pnpm' }
    const manifestFile = join(directory, NodeSetupDetector.manifestFileConst)
    // A manifest that cannot be parsed is not a workspace marker: what it declares is unreadable, and
    // inventing an ambiguity out of a file that may have nothing to do with this project would refuse
    // a project over its neighbour's damage. The project's OWN unreadable manifest is refused above.
    const manifest = await NodeSetupDetector.manifestOf(manifestFile)
    if (!manifest || !NodeSetupDetector.declaresWorkspaces(manifest)) return null
    return {
      root: directory,
      marker: manifestFile,
      toolId: await NodeSetupDetector.workspaceToolOf(directory, manifest),
    }
  }

  /** Both spellings: npm and yarn take an array, and yarn also takes `{ packages: [...] }`. */
  private static declaresWorkspaces(manifest: object): boolean {
    const field = (manifest as { workspaces?: unknown }).workspaces
    if (Array.isArray(field)) return field.length > 0
    if (typeof field !== 'object' || field === null) return false
    const packages = (field as { packages?: unknown }).packages
    return Array.isArray(packages) && packages.length > 0
  }

  /**
   * Which tool installs a manifest workspace, decided at its root by the same order the project
   * itself is decided by: the field, then a lone lockfile, then npm by convention. Null is the root
   * contradicting itself - two lockfiles, or a package manager this build cannot install with - and
   * the caller turns that into the ambiguity it is.
   */
  private static async workspaceToolOf(
    directory: string,
    manifest: object,
  ): Promise<SetupToolId | null> {
    const field = (manifest as { packageManager?: unknown }).packageManager
    if (typeof field === 'string') return NodeSetupDetector.toolOfName(field)
    const locks = await NodeSetupDetector.lockfilesOf(directory)
    if (locks.length > 1) return null
    return locks[0]?.toolId ?? 'node-npm'
  }

  private static async manifestOf(manifestFile: string): Promise<object | null> {
    if (!await SetupPaths.isFile(manifestFile)) return null
    try {
      const parsed: unknown = JSON.parse(await readFile(manifestFile, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed : null
    }
    catch { return null }
  }
}

/** A workspace found above a project: where it is, what says so, and what installs it. */
interface WorkspaceAbove {
  root: string
  marker: string
  /** Null when the root itself cannot say; the caller refuses rather than guessing for it. */
  toolId: SetupToolId | null
}
