import type { SessionRecordAgent } from '../records/sessionRecord.types'
import type { SessionAgentId, SessionCreateSpec } from '../sessionManagerApi.types'

export type SessionAgentSpec = NonNullable<SessionCreateSpec['agent']>

/**
 * What a launch is actually built from: the wire spec plus the one flag that never comes off the
 * wire. Print mode is chosen by this library for its own one-shot runs, and a session a person
 * started is not one anybody is waiting on the exit code of.
 */
export type AgentLaunchSpec = SessionAgentSpec & { oneShot?: true }

/**
 * The command line each launch mode turns into, one agent at a time.
 *
 * The flags were read off the installed CLIs on 2026-08-04 rather than assumed, because both are
 * moving targets: Claude Code 2.1.221 and Codex CLI 0.146.0.
 * (`.aidocs/engines/2026-08-04-006e-plan-sessions-split/04-cli-verification.md`.)
 *
 * | Claude | its own help text |
 * |---|---|
 * | `--session-id <uuid>` | "Use a specific session ID for the conversation (must be a valid UUID)" |
 * | `-r, --resume [value]` | "Resume a conversation by session ID, or open interactive picker with optional search term" |
 * | `-c, --continue` | "Continue the most recent conversation in the current directory" |
 * | `--fork-session` | "When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)" |
 *
 * | Codex | its own help text |
 * |---|---|
 * | `codex resume [SESSION_ID]` | "Session id (UUID) or session name. UUIDs take precedence if it parses." |
 * | `codex resume --last` | "Continue the most recent session without showing the picker" |
 * | `codex fork [--last]` | "Fork a previous interactive session (picker by default; use --last to fork the most recent)" |
 *
 * Codex is richer than the plan assumed: it resumes and forks BY ID, so `--last` is a fallback here
 * rather than the only thing it can do. What stays asymmetric is minting: Codex has no equivalent of
 * `--session-id` on the root command, so its native id is only knowable afterwards, from its history.
 *
 * A second probe on 2026-09-06, Claude Code 2.1.263 and Codex CLI 0.153.4, settled what the first
 * left open: **`--session-id` may be combined with `--resume <parent> --fork-session`.** The fork
 * carried the parent's history, its transcript landed under the given id, and the parent's own file
 * did not grow. Codex has no such switch anywhere - `codex fork` takes a session id and a prompt and
 * nothing else - so a Codex fork's id stays a thing found afterwards, from the rollout it wrote.
 *
 * **No branch may produce a bare `codex resume` or `codex fork`.** Both open an interactive picker,
 * and these processes run in a PTY with nobody at the keyboard: the picker would hold the session on
 * a menu forever. Every branch below therefore carries either an id or `--last`.
 */
export class AgentPresets {
  /**
   * The command line a create asked for. `minted` is the native id this client generated for the
   * launch, when it generated one.
   */
  static createArgs(agent: AgentLaunchSpec, minted: string | undefined): string[] {
    const args = AgentPresets.modeArgs(agent, minted)
    // In FRONT of the mode flags, because print mode is what the whole invocation is, and after the
    // prompt it would be read as more prompt.
    if (agent.oneShot) args.unshift(...AgentPresets.oneShotArgsOf(agent.agentId))
    // LAST, and positional: both CLIs read a trailing bare argument as the first thing to answer.
    // Anything appended after it would be read as more prompt rather than as a flag.
    if (agent.initialPrompt) args.push(agent.initialPrompt)
    return args
  }

  private static modeArgs(agent: AgentLaunchSpec, minted: string | undefined): string[] {
    if (agent.agentId === 'claude') return AgentPresets.claudeArgs(agent, minted)
    else if (agent.agentId === 'codex') return AgentPresets.codexArgs(agent)
    else throw new Error(`Unknown agent: ${JSON.stringify(agent)}`)
  }

  /**
   * The same launch again, for a create whose answer never arrived. It is the create shape and not
   * the resume shape on purpose: nothing ran, so there is no conversation to resume, and a session
   * started under a minted id must be replayed under that same id.
   */
  static replayArgs(agent: SessionRecordAgent): string[] {
    return AgentPresets.createArgs(
      {
        agentId: agent.agentId,
        mode: agent.launchMode,
        nativeSessionId: agent.nativeSessionId,
        forkParentId: agent.forkParentId,
        // The prompt is part of the command line, so a replay that dropped it would start the same
        // session against a different first turn. So is print mode: replaying a one-shot run as an
        // interactive one would leave a process nobody is waiting on sitting at a prompt.
        initialPrompt: agent.initialPrompt,
        oneShot: agent.oneShot,
      },
      agent.nativeSessionId,
    )
  }

  /**
   * Reopening a session that has already run is resuming what it left behind, which is why the
   * record's own launch mode decides and not the mode a create would use again.
   *
   * **Every reopen either agent gets is a resume BY ID**: a record that cannot name its conversation
   * is refused by `reopenProblem` before it reaches here, for Claude exactly as for Codex. A shape
   * that gate refuses cannot arrive here; if one does, the gate was bypassed, and that is an
   * invariant violation rather than a launch to improvise.
   */
  static reopenArgs(agent: SessionRecordAgent): string[] {
    const problem = AgentPresets.reopenProblem(agent)
    if (problem) throw new Error(`Refusing to build a reopen launch: ${problem}`)
    // `initialPrompt` is deliberately NOT carried: the conversation being resumed has already been
    // asked it, and asking again is a second first turn on top of whatever the answer was.
    return AgentPresets.createArgs(
      {
        agentId: agent.agentId,
        mode: AgentPresets.reopenModeOf(agent),
        // The parent is deliberately not carried over: reopening a fork must not fork it again.
        nativeSessionId: agent.nativeSessionId,
      },
      undefined,
    )
  }

  /**
   * Null when the record names the conversation a reopen would land on, a reason when it does not.
   * **The record must name it by ID; a fall-back that picks the newest conversation is not naming
   * it**, and the rule is the same for both agents because the harm is the same.
   *
   * Codex's `resume --last` is "the most recent session" on the whole machine. Claude's `--continue`
   * is the most recent one IN THE CURRENT DIRECTORY, which is a narrower net and still not identity:
   * two Claude sessions in one project - two `continue` launches, two forks, or any mix - share that
   * directory, and reopening the first lands it on whichever of them ran last. Both failures are
   * silent in exactly the same way: the record, the title, the cwd and the worktree all stay right
   * while the conversation belongs to another session. So **a reopen that cannot name its
   * conversation by id is refused rather than guessed**, for either agent.
   *
   * The price is deliberate and it is real, and what pays it is a record that cannot name itself: a
   * session started with `--continue`, and a fork taken before forks were given ids of their own
   * (minted for Claude, found for Codex). Both agents' own pickers still reach that history from a
   * plain shell session. What is NOT affected is the ordinary case - a Claude session created as
   * `new` or as a `fork` is launched under an id this client minted, a Codex one is named from the
   * rollout it wrote, and that id is what either is reopened by.
   */
  static reopenProblem(agent: SessionRecordAgent): string | null {
    if (agent.agentId === 'claude')
      return AgentPresets.reopenModeOf(agent) === 'resume'
        ? null
        : 'this conversation has no id of its own, and Claude\'s --continue takes the newest conversation in this directory, which is another session\'s as soon as two of them share it'
    else if (agent.agentId === 'codex')
      return AgentPresets.reopenModeOf(agent) === 'resume'
        ? null
        : 'Codex never reported the id of this conversation, and resuming the most recent session on this machine would land on an unrelated one'
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agent.agentId)}`)
  }

  /**
   * A record that names its conversation resumes it, whichever way it was launched. `continue` is
   * the one mode that never can: it landed on a conversation by recency, so nothing on the record
   * says which one it was.
   */
  private static reopenModeOf(agent: SessionRecordAgent): SessionAgentSpec['mode'] {
    if (agent.launchMode === 'new' || agent.launchMode === 'resume' || agent.launchMode === 'fork')
      return agent.nativeSessionId ? 'resume' : 'continue'
    else if (agent.launchMode === 'continue')
      return 'continue'
    else
      throw new Error(`Unknown launch mode: ${JSON.stringify(agent.launchMode)}`)
  }

  /**
   * Whether this agent has NO print mode this build can judge, which is what the name says and
   * what the answers mean: `claude` is false, `codex` is true.
   *
   * Claude's `-p` prints the answer and exits, which is what the merge resolver is judged by. Codex
   * has no equivalent this build knows of, so a conflict in a Codex session takes the manual path
   * from the start rather than launching something nothing can judge. When that changes, this is the
   * one line that changes with it.
   */
  static headlessUnsupported(agentId: SessionAgentId): boolean {
    if (agentId === 'claude') return false
    else if (agentId === 'codex') return true
    else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  private static oneShotArgsOf(agentId: SessionAgentId): string[] {
    if (agentId === 'claude') return ['-p']
    else if (agentId === 'codex')
      throw new Error('Codex has no print mode this build can judge; see headlessUnsupported')
    else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /**
   * Only Claude accepts an id chosen before the conversation exists, so only Claude gets one minted -
   * for a fresh conversation and for a fork alike, both of which start a conversation that does not
   * exist yet. `resume` and `continue` join one that does.
   */
  static mintsNativeSessionId(agent: SessionAgentSpec): boolean {
    return agent.agentId === 'claude' && (agent.mode === 'new' || agent.mode === 'fork')
  }

  private static claudeArgs(agent: AgentLaunchSpec, minted: string | undefined): string[] {
    if (agent.mode === 'new')
      // No minted id is still a launchable session, just one nothing can resume by id afterwards.
      return minted ? ['--session-id', minted] : []
    else if (agent.mode === 'continue')
      return ['--continue']
    else if (agent.mode === 'resume')
      return agent.nativeSessionId ? ['--resume', agent.nativeSessionId] : ['--continue']
    else if (agent.mode === 'fork') {
      const fork = agent.forkParentId
        ? ['--resume', agent.forkParentId, '--fork-session']
        : ['--continue', '--fork-session']
      // The resume flags first and the id last, the order the 2026-09-06 probe ran. The fork is a
      // conversation that does not exist yet, so it takes a minted id exactly as `new` does.
      return minted ? [...fork, '--session-id', minted] : fork
    }
    else
      throw new Error(`Unknown claude launch mode: ${JSON.stringify(agent.mode)}`)
  }

  private static codexArgs(agent: AgentLaunchSpec): string[] {
    if (agent.mode === 'new')
      return []
    else if (agent.mode === 'continue')
      return ['resume', '--last']
    else if (agent.mode === 'resume')
      return agent.nativeSessionId ? ['resume', agent.nativeSessionId] : ['resume', '--last']
    else if (agent.mode === 'fork')
      return agent.forkParentId ? ['fork', agent.forkParentId] : ['fork', '--last']
    else
      throw new Error(`Unknown codex launch mode: ${JSON.stringify(agent.mode)}`)
  }
}
