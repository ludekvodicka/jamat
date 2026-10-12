import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { WorktreeConfig, type WorktreeConfigRead } from '../../projectSetup/worktreeConfig'
import type { SessionsOpResult } from '../sessionManagerApi.types'
import type { CommandTrustStore } from './commandTrustStore'
import {
  DeclaredScripts,
  type DeclaredScript,
  type DeclaredScriptPhase,
  type DeclaredScriptsValue,
} from './declaredScripts'

export interface DeclaredCommands {
  /** The project's own `setup`, [] when absent. */
  setup: readonly string[]
  scripts: DeclaredScriptsValue
  hash: string
  /** What a person is shown: setup commands verbatim, then "before <name>: <command>", then "after <name>: <command>". */
  display: readonly string[]
}

/**
 * One read of `.worktree.json`, and everything a decision takes from the file: the agreement is checked
 * over this object and the steps that run are built from it, so no second read can swap them.
 */
export type DeclaredCommandsRead =
  | {
      kind: 'read'
      /** Null: the project declares nothing of its own. */
      value: DeclaredCommands | null
      /** What the same read says about `setup`, for `ProjectSetupManager.resolve`. */
      config: WorktreeConfigRead
    }
  /** The file is there and cannot be read or parsed: nothing in it can run. */
  | { kind: 'unreadable'; problem: string }
  /** The file reads and its `scripts` key is damaged: nobody can be shown what it declares. */
  | { kind: 'damaged'; problem: string }

/**
 * The one gate in front of every command a repository authors: `setup` and both `scripts` phases of
 * `.worktree.json`. `projectScanner` calls any directory under a category root a project, so a clone
 * dropped there is enough to get its file read, and these are the inputs this library executes that
 * nobody here wrote. One agreement covers all of them, per project and per hash.
 */
export class CommandAgreement {
  private static readonly noScriptsConst: DeclaredScriptsValue = { before: [], after: [] }
  private readonly trust: CommandTrustStore

  constructor(deps: { trust: CommandTrustStore }) {
    this.trust = deps.trust
  }

  /**
   * One read of the file. A damaged `setup` in a readable file adds nothing to the hash, since
   * `resolve` skips it with its reason, while the scripts beside it still count.
   */
  async declared(projectRoot: string): Promise<DeclaredCommandsRead> {
    const loaded = await WorktreeConfig.load(projectRoot)
    if (!loaded.ok) return { kind: 'unreadable', problem: loaded.problem }
    const scripts = WorktreeConfig.sectionOf(loaded, 'scripts', DeclaredScripts.coerce)
    if (!scripts.ok) return { kind: 'damaged', problem: scripts.problem }
    const config = WorktreeConfig.setupOf(loaded)
    const setup = config.ok && config.value ? config.value.setup : []
    const declared = scripts.value ?? CommandAgreement.noScriptsConst
    if (setup.length === 0 && declared.before.length === 0 && declared.after.length === 0)
      return { kind: 'read', value: null, config }
    return {
      kind: 'read',
      config,
      value: {
        setup,
        scripts: declared,
        hash: CommandAgreement.hashOf(setup, declared),
        display: [
          ...setup,
          ...declared.before.map((script) => CommandAgreement.lineOf('before', script)),
          ...declared.after.map((script) => CommandAgreement.lineOf('after', script)),
        ],
      },
    }
  }

  /**
   * A refusal to return, or null to carry on. The answer travels back as the hash the person was
   * shown, so it belongs to whoever saw the commands rather than to a flag set without seeing them.
   *
   * An unreadable file carries on: nothing in it can run, and the before chain skips with its reason.
   * A caller about to run commands from a read asks `agreed` over that same read.
   */
  gate(
    projectRoot: string,
    read: DeclaredCommandsRead,
    acknowledge: string | undefined,
  ): SessionsOpResult<never> | null {
    if (read.kind === 'unreadable') return null
    else if (read.kind === 'damaged') return { ok: false, code: 'invalid-spec', detail: read.problem }
    else if (read.kind === 'read') {
      const declared = read.value
      if (declared === null || this.trusted(projectRoot, declared)) return null
      if (acknowledge === declared.hash) {
        this.trust.acknowledge(projectRoot, declared.hash)
        return null
      }
      const count = declared.display.length
      return {
        ok: false,
        code: 'setup-not-acknowledged',
        detail: `${join(projectRoot, '.worktree.json')} asks to run ${count} command${count === 1 ? '' : 's'} `
          + 'in its worktrees, and this machine has not agreed to them',
        setup: { commands: declared.display, hash: declared.hash },
      }
    }
    else throw new Error(`Unknown declared commands read: ${JSON.stringify(read satisfies never)}`)
  }

  /**
   * Whether the commands of this read may run. A file that cannot be read or whose `scripts` key is
   * damaged is never agreed, since nobody was shown what it says.
   */
  agreed(projectRoot: string, read: DeclaredCommandsRead): boolean {
    if (read.kind === 'unreadable' || read.kind === 'damaged') return false
    else if (read.kind === 'read') return read.value === null || this.trusted(projectRoot, read.value)
    else throw new Error(`Unknown declared commands read: ${JSON.stringify(read satisfies never)}`)
  }

  /**
   * The commands and nothing else: re-indenting the file or adding an unrelated key keeps the
   * agreement, while changing, adding, removing or reordering a command withdraws it. A project with
   * `setup` alone hashes as it always did, so every agreement given before scripts existed holds.
   */
  static hashOf(setup: readonly string[], scripts: DeclaredScriptsValue): string {
    const plain = scripts.before.length === 0 && scripts.after.length === 0
    const input = plain ? setup : { setup, before: scripts.before, after: scripts.after }
    return createHash('sha256').update(JSON.stringify(input)).digest('hex')
  }

  private trusted(projectRoot: string, declared: DeclaredCommands): boolean {
    return this.trust.acknowledgedHashOf(projectRoot) === declared.hash
  }

  private static lineOf(phase: DeclaredScriptPhase, script: DeclaredScript): string {
    const where = script.cwd === '' ? '' : ` (in ${script.cwd})`
    return `${phase} ${script.name}${where}: ${script.command}`
  }
}
