import { basename } from 'node:path'

import type { SessionRecord, SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import type { SessionCreateSpec, SessionWorkflowInfo, SvnActionNeed } from '../../sessionManager/sessionManagerApi.types'
import type { RuntimeChannel } from '../../shared/configIdentity.types'
import { SvnActionStages } from '../finish/svnActionStages'
import { SvnMergerLauncher } from './svnMergerLauncher'
import { SvnResolverLauncher } from './svnResolverLauncher'

/** What a helper brief is written from: the session, its waiting action, the workflow so far and where things are. */
export interface SvnWaitHelperBriefInput {
  title: string
  sessionId: string
  action: SessionRecordSvnAction
  need: NonNullable<SessionRecordSvnAction['needs']>
  workflow: SessionWorkflowInfo | null
  /** The saved log of each run step, by run id. */
  logOf: (runId: string) => string
  /** The command line of this client's Jamat CLI, `RunTools.agentCli`. */
  cli: string
  /**
   * This client's instance. The agent is a session of its own, so `--self` would name the agent and not
   * the session it helps; a call with neither met two running instances (UA1-J14R-4).
   */
  instance: { configIdentity: string; channel: RuntimeChannel }
}

/**
 * The interactive agent the person starts on a waiting SVN action (Solve with agent). It is a session
 * of its own beside the action, never a run of it: the action keeps waiting, the agent finds why and
 * fixes what it can in the worktree, and the person then presses the action's button. It is told to
 * say how the Finish could avoid the wait next time, so a failure of Jamat itself gets reported.
 */
export class SvnWaitHelper {
  /**
   * Whether Solve with agent is offered: a Finish or a Discard that waits for the person. A Finish
   * that waits on conflicts its merger may settle has Resolve with agent instead.
   */
  static offered(action: SessionRecordSvnAction): boolean {
    if (action.needs === undefined) return false
    const kind = action.kind
    switch (kind) {
      case 'finish':
        return action.needs.kind !== 'conflict' || !SvnActionStages.resumesAtFixing(action)
          || !(action.conflictSet?.entries ?? []).some(SvnMergerLauncher.forAgent)
      case 'discard': return true
      case 'update-main': return false
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** The worker's Claude conversation when it ran in this worktree, so it knows the change; else a new one of the worker's agent. */
  static specOf(parent: SessionRecord, input: { root: string; briefFile: string }): SessionCreateSpec {
    const prompt = SvnWaitHelper.promptOf(input.briefFile)
    const title = `Solve ${basename(input.root)}`
    const link = { sessionId: parent.sessionId, kind: 'worker' as const }
    const fork = SvnResolverLauncher.forkOf(parent, input.root)
    if (fork !== null)
      return {
        kind: 'agent',
        directory: { mode: 'adHoc', path: fork.cwd },
        agent: { agentId: 'claude', mode: 'fork', forkParentId: fork.nativeSessionId, initialPrompt: prompt },
        parent: link,
        title,
      }
    return {
      kind: 'agent',
      directory: { mode: 'adHoc', path: input.root },
      agent: { agentId: parent.agent?.agentId ?? 'claude', mode: 'new', initialPrompt: prompt },
      parent: link,
      title,
    }
  }

  /** One line: it travels as a command-line argument, and cmd.exe cuts one at its first newline. */
  static promptOf(briefFile: string): string {
    return `Jamat's SVN Finish of this worktree stopped and waits for the person. Read ${briefFile}, find why it waits, `
      + 'fix what you can in this worktree within its rules, then say which button the person presses next and how Jamat could avoid this wait. '
      + 'SVN writes are blocked by the worktree shim; use Jamat settlement commands and preserve the person-owned Finish.'
  }

  static briefOf(input: SvnWaitHelperBriefInput): string {
    const { action, need } = input
    const target = `--session-id ${input.sessionId} --config-identity ${input.instance.configIdentity} --channel ${input.instance.channel}`
    const runs = (input.workflow?.rounds ?? []).flatMap((round) => round.steps)
      .flatMap((step) => 'runId' in step.target && step.target.kind === 'run' ? [`- ${step.title}: \`${input.logOf(step.target.runId)}\``] : [])
    return [
      `# Why the ${SvnWaitHelper.kindWordOf(action)} of ${input.title} waits`,
      '',
      `Worktree: \`${action.root}\``,
      `Session: \`${input.sessionId}\``,
      '',
      `It waits on **${need.kind}**: ${need.reason}`,
      '',
      '## What to do',
      '',
      ...SvnWaitHelper.taskOf(need.kind, input.cli, target),
      '',
      '## The workflow so far',
      '',
      ...SvnWaitHelper.stepLinesOf(input.workflow),
      '',
      ...runs.length === 0 ? [] : ['## Logs of its runs', '', ...runs, ''],
      '## Rules',
      '',
      '- Never run `svn commit`, `svn update`, `svn revert`, `svn switch`, `svn resolve` or `svn delete`, and never remove the worktree. '
        + 'Jamat runs every svn write of the Finish itself, and the person commits in its review.',
      '- Read-only svn is fine: `svn status`, `svn info`, `svn log`, `svn diff`, `svn cat`.',
      '- Never press the Finish yourself (`jamat-v3 sessions finish-worktree`); the person does.',
      `- \`${input.cli} sessions worktree ${target}\` shows the action as it stands now.`,
      '',
      '## Your answer',
      '',
      '1. What made it wait, and what you changed (files and why).',
      '2. Which button the person presses next in the Workflow pane, or what they must do outside Jamat first.',
      '3. **How Jamat could avoid this wait**: a concrete change to the SVN Finish (a rule, a check, a step or a clearer message), '
        + 'or "nothing" when the wait was right. If it looks like a bug of Jamat itself, say so and name the message that shows it.',
      '',
    ].join('\n')
  }

  /** What the agent does for each wait: the person's next press is part of it. `target` selects the session and this instance. */
  private static taskOf(need: SvnActionNeed, cli: string, target: string): string[] {
    switch (need) {
      case 'incoming':
        return [
          'svn update brought in other commits that changed the same project. Nothing conflicted, but nothing checked that both changes still fit.',
          '- Read those commits (`svn log -v` and `svn diff -c <revision>` of each) and compare them with what this session changed (`svn status`, `svn diff`).',
          '- Run the project\'s build, typecheck and tests where it has them, and fix what the combination broke, in the worktree.',
          '- The person then presses Continue to review.',
        ]
      case 'check-failed':
        return [
          'A check the project declares failed. Its log is listed below.',
          '- Read the log, fix the cause in the worktree and run the check again yourself.',
          '- The person then presses Finish again.',
        ]
      case 'conflict':
        return [
          'svn update left conflicts that Jamat\'s rules and its merger may not settle; the person settles them in the conflict list.',
          `- \`${cli} sessions conflicts ${target}\` lists them with their options.`,
          '- Look at each path, edit the files where a merged result is needed, and tell the person which option to choose for each path.',
          '- The person then presses Check again.',
        ]
      case 'resolver-failed':
        return [
          'The conflict resolver did not finish its work: conflict markers are left, or it could not start or ran too long.',
          '- Find the files that still hold `<<<<<<<`, `=======` or `>>>>>>>` lines, merge them by the intent of both sides and remove every marker line.',
          '- The person then presses the action\'s button again.',
        ]
      case 'out-of-date':
        return [
          'Newer commits arrived while the review was open, twice. Usually nothing is wrong with the change itself.',
          '- Check that nothing in the worktree is broken, and tell the person to press Finish again.',
        ]
      case 'review-cancelled':
      case 'review-interrupted':
      case 'partial':
        return [
          'The review ended without committing everything.',
          '- List what is still changed (`svn status`) and say whether each change belongs to this session\'s work or should be reverted by the person.',
          '- The person then presses Finish again to review the rest.',
        ]
      case 'pinned-external':
        return [
          'A changed external is pinned to a revision, so the review cannot commit it.',
          '- Name the external and the pin, and give the person the exact steps: commit the external in its own working copy, then move the pin.',
          '- The person then presses Finish again.',
        ]
      case 'locked':
        return [
          'The working copy is locked by an svn process that ended or still runs.',
          '- Find what holds it. When no svn process works in it, `svn cleanup` in the worktree is allowed.',
          '- The person then presses the action\'s button again.',
        ]
      case 'svn-failed':
        return [
          'An svn command of the Finish failed, or Jamat could not read what svn answered.',
          '- Run the read-only svn command the message names yourself and compare what it prints with what the message expects.',
          '- If svn itself fails, fix the working copy where the rules allow it. If svn works and Jamat misread it, that is a bug of Jamat: say so.',
          '- The person then presses the action\'s button again.',
        ]
      case 'removal-blocked':
        return ['Removal kept the worktree because its content could not be preserved or changed after the check.',
          '- Inspect the named paths and copies, then ask the person to retry or keep the worktree.']
      case 'not-stopped':
        return [
          'The worktree\'s session did not stop in time.',
          '- Find which process still works in the worktree and tell the person how to stop it.',
          '- The person then presses the action\'s button again.',
        ]
      case 'worker-busy':
        return [
          'The Finish waits because the worker session is still working.',
          '- Tell the person whether the worker is close to done. The person presses Sync now, or Back to work to end this Finish.',
        ]
      default: throw new Error(`Unknown SVN action need: ${JSON.stringify(need satisfies never)}`)
    }
  }

  private static stepLinesOf(workflow: SessionWorkflowInfo | null): string[] {
    const rounds = workflow?.rounds ?? []
    if (rounds.length === 0) return ['No step was recorded.']
    return rounds.flatMap((round) => [
      ...rounds.length > 1 ? [`${round.title}:`] : [],
      ...round.steps.map((step) => `- [${step.state}] ${step.title}${step.detail === '' ? '' : `: ${step.detail}`}`),
    ])
  }

  private static kindWordOf(action: SessionRecordSvnAction): string {
    const kind = action.kind
    switch (kind) {
      case 'finish': return 'Finish'
      case 'discard': return 'Discard'
      case 'update-main': return 'UPDATE'
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }
}
