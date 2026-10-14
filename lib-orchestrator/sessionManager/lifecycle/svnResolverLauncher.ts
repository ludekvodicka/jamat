import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { PathCompare } from '../../shared/pathCompare'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { AgentPresets } from '../launch/agentPresets'
import { WindowsCommand } from '../launch/windowsCommand'
import type { SessionRecord, SessionRecordSvnAction } from '../records/sessionRecord.types'
import type { ScriptLogStore } from '../scripts/scriptLogStore'
import type { SessionCreateSpec, SvnActionKind } from '../sessionManagerApi.types'

/** What the resolver of an SVN action needs beside the records: a Claude to run, a place for its brief, a read of its work. */
export interface SvnResolverPort {
  /** Why no headless Claude can resolve conflicts on this machine, or null. */
  unavailable(): string | null
  briefs: Pick<ScriptLogStore, 'briefPathOf' | 'writeBrief' | 'mergeBriefPathOf' | 'writeMergeBrief'>
  /** The conflicted files that still hold a conflict marker line, hold binary content or cannot be read. */
  withMarkers(root: string, paths: readonly string[]): Promise<string[]>
}

/**
 * Who resolves the text conflicts an SVN action's update left, and what it is told. The worker's own
 * conversation is forked when the worker is Claude with a native id, because it knows why each change
 * was made; otherwise a fresh Claude one-shot reads the brief file. Either runs in Claude's
 * accept-edits permission mode in print mode, so it edits files and runs only the commands the
 * person's Claude settings allow already; whatever it changes is verified, never trusted.
 *
 * The exit code decides nothing: `SvnActionFlow` verifies the files afterwards, whatever it is.
 */
export class SvnResolverLauncher {
  static readonly limitMillisecondsConst = 20 * 60_000
  /** svn writes `<<<<<<< .mine`, `||||||| .r<N>`, `=======` and `>>>>>>> .r<N>`, each on a line of its own. */
  private static readonly markerConst = /^(?:<{7}|\|{7}|={7}|>{7})(?:[ \t\r]|$)/m

  /**
   * The worker's conversation when it is Claude with a native id it ran in this working copy, else a
   * fresh Claude one-shot. A conversation that ran in a worktree below a main copy is never forked
   * into an update of that main copy: its directory is gone.
   */
  static specOf(parent: SessionRecord, input: { root: string; briefFile: string }): SessionCreateSpec {
    const prompt = SvnResolverLauncher.promptOf(input.briefFile)
    const title = `Resolve conflicts ${basename(input.root)}`
    const fork = SvnResolverLauncher.forkOf(parent, input.root)
    if (fork !== null)
      return {
        kind: 'agent',
        directory: { mode: 'adHoc', path: fork.cwd },
        agent: { agentId: 'claude', mode: 'fork', forkParentId: fork.nativeSessionId, initialPrompt: prompt },
        title,
      }
    return {
      kind: 'agent',
      directory: { mode: 'adHoc', path: input.root },
      agent: { agentId: 'claude', mode: 'new', initialPrompt: prompt },
      title,
    }
  }

  /**
   * The worker's Claude conversation to fork and the directory it ran in, when it ran in `root`;
   * null otherwise. Claude finds a conversation by the directory it ran in, so a fork runs there.
   */
  static forkOf(parent: SessionRecord, root: string): { cwd: string; nativeSessionId: string } | null {
    const agent = parent.agent
    const cwd = parent.transcriptCwd ?? root
    const below = PathCompare.normalized(cwd).slice(PathCompare.normalized(root).length).split('/')
    const inside = PathCompare.isInside(root, cwd) && !below.includes(SvnWorktreeManager.worktreesDirConst)
    return agent?.agentId === 'claude' && agent.nativeSessionId !== undefined && inside ? { cwd, nativeSessionId: agent.nativeSessionId } : null
  }

  /** One line: it travels as a command-line argument, and cmd.exe cuts one at its first newline. */
  static promptOf(briefFile: string): string {
    return `An svn update in this working copy stopped on conflicts. Read ${briefFile} and resolve every conflict it lists, `
      + 'editing only the files it names. Run no command and commit nothing.'
  }

  /** The conflict list, the session and the rules, written beside the action's run logs. */
  static briefOf(input: { kind: SvnActionKind; title: string; root: string; paths: readonly string[] }): string {
    const mainCopy = SvnResolverLauncher.inMainCopy(input.kind)
    return [
      'SVN conflicts to resolve',
      '',
      `Session: ${input.title}`,
      `${mainCopy ? 'Main copy' : 'Working copy'}: ${input.root}`,
      '',
      ...mainCopy
        ? ['svn update brought other commits into this main copy, and they conflict with local changes',
          'nobody has committed yet in these files (paths relative to the main copy):']
        : ['svn update brought other commits into this working copy, and they conflict with the changes of',
          'this session in these files (paths relative to the working copy):'],
      '',
      ...input.paths.map((path) => `- ${path}`),
      '',
      'Rules:',
      '- Settle every conflict block in each listed file: <<<<<<< .mine, ||||||| .r<base>, =======,',
      '  >>>>>>> .r<new>. Keep the intent of both sides where both are wanted; otherwise keep the',
      `  incoming change and make the ${mainCopy ? 'local change' : 'change of this session'} again on top of it.`,
      '- Remove every conflict marker line.',
      '- Edit only the files listed above. Create, delete or rename no file.',
      ...mainCopy
        ? ['- Run no command: no svn, no build, no tests. Jamat checks your work, marks the files resolved',
          '  and shows the merge as a diff of the resolved files.']
        : ['- Run no command: no svn, no build, no tests. Jamat checks your work, marks the files resolved,',
          '  runs the checks of the project and opens the commit review itself.'],
      '- Stop when every listed file is free of conflicts.',
      '',
    ].join('\n')
  }

  private static inMainCopy(kind: SvnActionKind): boolean {
    if (kind === 'update-main') return true
    else if (kind === 'finish' || kind === 'discard') return false
    else throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
  }

  /** The resolver of a waiting action ran past its limit: it is stopped, and the person decides. */
  static overdue(action: SessionRecordSvnAction, now: number): boolean {
    return action.stage === 'resolving' && action.needs === undefined && action.verdict === undefined
      && action.conflicts !== undefined && now - action.conflicts.at > SvnResolverLauncher.limitMillisecondsConst
  }

  /**
   * Why Claude cannot run a resolver on this machine, or null. On Windows the name must start an
   * image or an installer's PowerShell script, the launches that need no cmd.exe guess.
   */
  static claudeProblem(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string | null {
    if (AgentPresets.headlessUnsupported('claude')) return 'Claude has no print mode this build can judge'
    if (platform !== 'win32') return null
    return WindowsCommand.imageOf('claude', environment) !== null || WindowsCommand.powershellScriptOf('claude', environment) !== null
      ? null
      : 'claude was not found on PATH'
  }

  /** A file that cannot be read or holds a NUL byte counts as unresolved: no marker can prove it clean. */
  static async markersIn(root: string, paths: readonly string[]): Promise<string[]> {
    const left: string[] = []
    for (const path of paths) {
      let content: Buffer
      try {
        content = await readFile(join(root, ...path.split('/')))
      } catch {
        left.push(path)
        continue
      }
      if (content.includes(0) || SvnResolverLauncher.markerConst.test(content.toString('utf8'))) left.push(path)
    }
    return left
  }
}
