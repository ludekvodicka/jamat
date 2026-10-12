import { basename } from 'node:path'

import { SvnWorktreeEvidence } from '../../svn/svnWorktreeEvidence'
import type {
  SessionRecord,
  SessionRecordProcess,
  SessionRecordScriptLink,
  SessionRecordScriptStep,
  SessionRecordSetupCommand,
} from '../records/sessionRecord.types'

/** The record of a scripted shell run, before it is written. */
export interface ScriptShellRun {
  runId: string
  operationId: string
  link: SessionRecordScriptLink
  title: string
  commands: SessionRecordSetupCommand[]
  now: number
}

/** The record of a direct-process run: the same pair and link, with a tool in place of a shell. */
export interface ScriptProcessRun extends Omit<ScriptShellRun, 'commands'> {
  process: SessionRecordProcess & { cwd: string }
}

/** The records a script run is written as. */
export class ScriptRunRecords {
  /**
   * A shell with a script instead of a prompt, `starting` under its own pending pair.
   *
   * It carries NO `worktree` field although it runs inside one: `LaunchPlanner.cwdOf` prefers a
   * record's worktree path over its directory, so the field would silently move a step that asked for
   * a directory inside the worktree (a pnpm workspace root above the project, say) back to the top of
   * it. The directory is the first step's own, and every step cd's to its own anyway.
   */
  static shellRun(run: ScriptShellRun): SessionRecord {
    if (run.commands.length === 0) throw new Error(`Script run ${run.runId} has no command to run`)
    return {
      sessionId: run.runId,
      kind: 'shell',
      title: run.title,
      directory: { mode: 'adHoc', path: run.commands[0].cwd },
      commands: run.commands,
      scriptOf: run.link,
      binding: null,
      life: 'starting',
      pendingOperationId: run.operationId,
      pendingOperationKind: 'create',
      createdAt: run.now,
    }
  }

  /**
   * A tool spawned directly in `process.cwd`, `starting` under its own pending pair; carries no
   * `worktree` for the reason `shellRun` gives. An argument svn.exe would read as another name is a
   * programming error: every flow passes names it has already checked.
   */
  static processRun(run: ScriptProcessRun): SessionRecord {
    const refused = run.process.args.find((arg) => !SvnWorktreeEvidence.takesArgument(arg))
    if (refused !== undefined)
      throw new Error(`Script run ${run.runId} has an argument a direct process cannot take: ${JSON.stringify(refused)}`)
    return {
      sessionId: run.runId,
      kind: 'shell',
      title: run.title,
      directory: { mode: 'adHoc', path: run.process.cwd },
      process: { tool: run.process.tool, args: [...run.process.args] },
      scriptOf: run.link,
      binding: null,
      life: 'starting',
      pendingOperationId: run.operationId,
      pendingOperationKind: 'create',
      createdAt: run.now,
    }
  }

  /** "Checkout i12-fix" for the SVN checkout, "Setup i12-fix" for the install, "codegen i12-fix" for a step the project named. */
  static titleOf(step: Pick<SessionRecordScriptStep, 'scriptId' | 'name'>, worktreePath: string): string {
    const folder = basename(worktreePath)
    if (step.scriptId === 'setup') return `Setup ${folder}`
    else if (step.scriptId === 'svn') return `Checkout ${folder}`
    else if (step.scriptId === 'declared' || step.scriptId === 'checks') return `${step.name} ${folder}`
    else throw new Error(`Unknown chain step: ${JSON.stringify(step.scriptId satisfies never)}`)
  }

  /**
   * What a run runs, as the log header and the history show it: its shell commands, or the tool it
   * spawns with its arguments in its directory.
   */
  static commandsOf(run: SessionRecord): SessionRecordSetupCommand[] {
    if (run.process === undefined) return run.commands ?? []
    const cwd = run.directory.mode === 'adHoc' ? run.directory.path : ''
    return [{ command: [run.process.tool, ...run.process.args].join(' '), cwd }]
  }
}
