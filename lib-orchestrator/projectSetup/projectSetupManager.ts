import { GoSetupDetector } from './detectors/goSetupDetector'
import { NodeSetupDetector } from './detectors/nodeSetupDetector'
import { PythonSetupDetector } from './detectors/pythonSetupDetector'
import { RustSetupDetector } from './detectors/rustSetupDetector'
import type {
  DeclaredSetup,
  PlatformSettingsValue,
  SetupDetector,
  SetupResolution,
  SetupStep,
  SetupToolId,
} from './projectSetup.types'
import { SetupFamilies } from './setupFamilies'
import { SetupPaths } from './setupPaths'
import { SetupTrustStore } from './setupTrust'
import { WorktreeConfig } from './worktreeConfig'

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
 * are this machine's own answers. `declaredSetup` is how a caller asks about it before running
 * anything, and `acknowledgeSetup` is how a person's answer is remembered.
 *
 * Ambiguity anywhere fails everything. A repository of two families where one of them cannot be
 * decided would otherwise be provisioned half installed, which is a worktree that is broken quietly
 * rather than a session that says what is missing.
 */
export class ProjectSetupManager {
  /** Fixed array, order binding: a repository of several families installs in this order. */
  private readonly detectors: readonly SetupDetector[]
  private readonly platformSettingsOf: () => PlatformSettingsValue
  private readonly trust: SetupTrustStore

  constructor(deps: {
    /** Machine state, not configuration: what a person answered here does not travel with a config
     *  directory copied to another machine. */
    trustFile: string
    /**
     * This machine's tier, read per call rather than captured. It arrives as a function because the
     * client owns the file it lives in: the manager decides the command and never where the option
     * came from, the same split `versioningModeOf` already makes for the session manager.
     */
    platformSettingsOf: () => PlatformSettingsValue
    report?: (message: string) => void
  }) {
    this.platformSettingsOf = deps.platformSettingsOf
    this.trust = SetupTrustStore.load(deps.trustFile, deps.report)
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
   */
  async resolve(projectRoot: string, repositoryRoot: string): Promise<SetupResolution> {
    const config = await WorktreeConfig.read(projectRoot)
    if (!config.ok) return { kind: 'none', reason: config.problem }
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
    const steps: SetupStep[] = []
    for (const detector of this.detectors) {
      const detection = await detector.detect(projectRoot, repositoryRoot)
      if (detection === null) continue
      if (detection.kind === 'ambiguous')
        return { kind: 'none', reason: `${detector.familyId}: ${detection.reason}` }
      else if (detection.kind === 'tool')
        steps.push({
          command: this.commandOf(detection.toolId),
          cwd: detection.installCwd ?? projectCwd,
        })
      else
        throw new Error(`Unknown detection: ${JSON.stringify(detection)}`)
    }
    if (steps.length === 0)
      return {
        kind: 'none',
        reason: 'no known project family detected; add a .worktree.json with a "setup" array',
      }
    return { kind: 'setup', origin: 'machine', steps }
  }

  /**
   * What the project itself declares, and whether this machine has agreed to run it. Null when the
   * project declares nothing of its own - a damaged file included, because a file that cannot be read
   * cannot be agreed to either, and `resolve` is where that refusal is already spelled out.
   *
   * This is the one question that can be answered before a worktree exists: `.worktree.json` is read
   * at the project root, and the repository root the steps are relative to matters only once they
   * are about to run.
   */
  async declaredSetup(projectRoot: string): Promise<DeclaredSetup | null> {
    const config = await WorktreeConfig.read(projectRoot)
    if (!config.ok || !config.value || config.value.setup.length === 0) return null
    const commands = config.value.setup
    const hash = SetupTrustStore.hashOf(commands)
    return { commands, hash, acknowledged: this.trust.acknowledgedHashOf(projectRoot) === hash }
  }

  /** Remembered per project AND per command list, so moving a command asks the question again. */
  acknowledgeSetup(projectRoot: string, hash: string): void {
    this.trust.acknowledge(projectRoot, hash)
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
