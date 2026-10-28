import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { ProductGroup } from '../shared/productGroup'
import { GoSetupDetector } from './detectors/goSetupDetector'
import { NodeSetupDetector } from './detectors/nodeSetupDetector'
import { PythonSetupDetector } from './detectors/pythonSetupDetector'
import { RustSetupDetector } from './detectors/rustSetupDetector'
import type {
  PlatformSettingsValue,
  SetupDetector,
  SetupResolution,
  SetupScope,
  SetupStep,
  SetupToolId,
} from './projectSetup.types'
import { SetupFamilies } from './setupFamilies'
import { SetupPaths } from './setupPaths'
import type { WorktreeConfigRead } from './worktreeConfig'

/**
 * The member's whole surface: hand it a project root, hear what the project is and what installs its
 * dependencies. It runs nothing, and `dev`, `cleanup` and ports are not its, now or later - the name
 * says what comes out, and this sentence is the fence.
 *
 * Three levels of precedence, only the first of which is the project's own word: `.worktree.json`
 * beats everything, then a detected family whose command comes from this machine's settings, then
 * the family's built-in default. Keeping the command out of the detectors is what holds "what this
 * project is" and "how this machine installs it" apart.
 *
 * **That first tier is also the only foreign one, and `origin` is what says so.** A `.worktree.json`
 * arrives with a clone and was written by whoever authored the repository, while the other two tiers
 * are this machine's own answers. Whether a person agreed to run it is not this class's question:
 * `CommandAgreement` in the session manager asks it over every command the file declares.
 *
 * Ambiguity anywhere fails everything. A repository of two families where one of them cannot be
 * decided would otherwise be provisioned half installed, which is a worktree that is broken quietly
 * rather than a session that says what is missing.
 */
export class ProjectSetupManager {
  private static readonly nothingDetectedConst =
    'no known project family detected; add a .worktree.json with a "setup" array'
  /** Fixed array, order binding: a repository of several families installs in this order. */
  private readonly detectors: readonly SetupDetector[]
  private readonly platformSettingsOf: () => PlatformSettingsValue

  constructor(deps: {
    /**
     * This machine's tier, read per call rather than captured. It arrives as a function because the
     * client owns the file it lives in: the manager decides the command and never where the option
     * came from, the same split `versioningModeOf` already makes for the session manager.
     */
    platformSettingsOf: () => PlatformSettingsValue
  }) {
    this.platformSettingsOf = deps.platformSettingsOf
    this.detectors = [
      new NodeSetupDetector(),
      new PythonSetupDetector(),
      new RustSetupDetector(),
      new GoSetupDetector(),
    ]
  }

  /**
   * Read in the main copy, run in the worktree: the steps come back with repository-relative
   * directories, so the caller maps them into whichever worktree it just created.
   *
   * `config` is what the project's `.worktree.json` says about `setup`, read by the caller: the caller
   * checks the agreement over that same read, so what resolves here is what was agreed to.
   */
  async resolve(projectRoot: string, repositoryRoot: string, config: WorktreeConfigRead, scope?: SetupScope): Promise<SetupResolution> {
    if (!config.ok) return { kind: 'none', reason: config.problem }
    if (scope === undefined) {
      const group = ProductGroup.readAt(projectRoot)
      if (!group.ok) return { kind: 'none', reason: group.detail }
      if (group.kind === 'product') scope = 'members'
      else if (group.kind === 'collection' || group.kind === null) scope = 'project'
      else throw new Error(`Unknown group kind: ${group.kind satisfies never}`)
    }
    // The step's directory is repository-relative or there is no step: a project outside the
    // repository its worktree was cut from would otherwise be installed in the real checkout.
    const projectCwd = SetupPaths.relativeOf(repositoryRoot, projectRoot)
    if (projectCwd === null)
      return {
        kind: 'none',
        reason: `${projectRoot} is not inside the repository ${repositoryRoot}, so there is no`
          + ' directory inside a worktree to install it in',
      }
    if (config.value) {
      if (config.value.setup.length === 0) return { kind: 'empty' }
      return {
        kind: 'setup',
        origin: 'project',
        steps: config.value.setup.map((command) => ({ command, cwd: projectCwd })),
      }
    }
    const root = await this.detectAt(projectRoot, repositoryRoot, projectCwd)
    if (root.kind === 'steps') return { kind: 'setup', origin: 'machine', steps: root.steps }
    else if (root.kind === 'refused') return { kind: 'none', reason: root.reason }
    else if (root.kind !== 'nothing') throw new Error(`Unknown detection at the root: ${JSON.stringify(root)}`)
    if (scope === 'project')
      return { kind: 'none', reason: ProjectSetupManager.nothingDetectedConst }
    else if (scope !== 'members') throw new Error(`Unknown setup scope: ${scope satisfies never}`)
    const steps: SetupStep[] = []
    for (const member of await ProjectSetupManager.membersOf(projectRoot)) {
      const memberCwd = projectCwd === '' ? member : `${projectCwd}/${member}`
      const found = await this.detectAt(join(projectRoot, member), repositoryRoot, memberCwd)
      // Half a group installed is a worktree that is broken quietly, the same as half a project.
      if (found.kind === 'refused') return { kind: 'none', reason: `member ${member}: ${found.reason}` }
      // Two members of one workspace both answer its root, and installing it twice gains nothing.
      else if (found.kind === 'steps')
        steps.push(...found.steps.filter((step) =>
          !steps.some((known) => known.command === step.command && known.cwd === step.cwd)))
      else if (found.kind !== 'nothing') throw new Error(`Unknown detection of a member: ${JSON.stringify(found)}`)
    }
    if (steps.length === 0) return { kind: 'none', reason: ProjectSetupManager.nothingDetectedConst }
    return { kind: 'setup', origin: 'machine', steps }
  }

  /** Every detector over one directory; `cwd` is that directory's repository-relative spelling. */
  private async detectAt(directory: string, repositoryRoot: string, cwd: string): Promise<DetectedAt> {
    const steps: SetupStep[] = []
    for (const detector of this.detectors) {
      const detection = await detector.detect(directory, repositoryRoot)
      if (detection === null) continue
      if (detection.kind === 'ambiguous')
        return { kind: 'refused', reason: `${detector.familyId}: ${detection.reason}` }
      else if (detection.kind === 'tool')
        steps.push({
          command: this.commandOf(detection.toolId),
          cwd: detection.installCwd ?? cwd,
        })
      else
        throw new Error(`Unknown detection: ${JSON.stringify(detection)}`)
    }
    return steps.length === 0 ? { kind: 'nothing' } : { kind: 'steps', steps }
  }

  /**
   * The group's projects: its direct child directories in name order, so the steps come out the same
   * on every resolve, a retry included. Dot directories (`.private`, `.worktrees`, `.aidocs`) and
   * `node_modules` hold no member.
   */
  private static async membersOf(groupRoot: string): Promise<string[]> {
    const entries = await readdir(groupRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  }

  /**
   * The one place a command is decided: settings first, then the family's built-in default. The
   * table itself sits in `SetupFamilies` because the settings window prints it, and a table this
   * class kept private would be retyped over there and drift from what actually runs.
   */
  private commandOf(toolId: SetupToolId): string {
    return SetupFamilies.commandOf(toolId, this.platformSettingsOf())
  }
}

/** What the detectors made of one directory: install steps, nothing of theirs, or a refusal. */
type DetectedAt =
  | { kind: 'steps'; steps: SetupStep[] }
  | { kind: 'nothing' }
  | { kind: 'refused'; reason: string }
