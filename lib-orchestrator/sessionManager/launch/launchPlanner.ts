import { homedir } from 'node:os'

import type { RuntimeChannel, RuntimeLaunchSpec } from '../../../app-host/app/wire/hostWire.js'
import { ChildEnvironment } from '../../shared/childEnvironment'
import type {
  SessionDirectoryRef,
  SessionRecord,
  SessionRecordAgent,
  SessionRecordSetupCommand,
} from '../records/sessionRecord.types'
import { AgentPresets } from './agentPresets'

export interface LaunchPlanOptions {
  controller?: { configIdentity: string; channel: RuntimeChannel }
  cols?: number
  rows?: number
  /**
   * What a create asked for. A reopen and a replayed create leave it out and get what the record can
   * still be resumed with, which is all that survives a client restart.
   */
  agentArgs?: string[]
  /**
   * Run this agent without being asked anything. Absent means gated, and that direction is the
   * point: a caller that forgets it gets today's launch, never a silent one with full rights.
   */
  yolo?: boolean
  /**
   * The model this launch starts on. Absent means no opinion: no flag is emitted at all and the
   * agent starts on its own default, which both of them have and a user may have set themselves.
   * `SessionLifecycle` is the only thing that decides it, and only for a launch that FOUNDS a
   * conversation.
   */
  model?: string
  /**
   * The reasoning level this launch starts on, under exactly the rule `model` follows: absent
   * emits nothing, and only a launch that FOUNDS a conversation is given one. Independent of
   * `model` - an effort with no model applies to whatever default the agent starts on.
   */
  effort?: string
  /**
   * The two shapes this class decides - the win32 wrap and the stripped environment - are the whole
   * reason it exists, and both are read off the running process. They are injectable so a test can
   * assert either shape from either platform instead of asserting whatever it happens to run on.
   */
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}

/**
 * A session record turned into the complete launch AppHost spawns. The Host adds nothing of its own,
 * so everything the child will see is decided here.
 */
export class LaunchPlanner {
  static readonly sessionIdVariableConst = 'JAMAT_V3_SESSION_ID'
  static readonly sessionControllerVariableConst = 'JAMAT_V3_SESSION_CONTROLLER'
  static readonly sessionChannelVariableConst = 'JAMAT_V3_SESSION_CHANNEL'
  private static readonly defaultColsConst = 120
  private static readonly defaultRowsConst = 30
  /**
   * The scripted branch runs under `/bin/sh`, never under `$SHELL`. `$SHELL` is the user's LOGIN
   * shell, which is the right answer for the terminal a person types in and the wrong one for a line
   * this class wrote: `SHELL=/usr/bin/fish` refuses the line outright (`$? is not the exit status`,
   * exit 127, measured - nothing of the install runs), and the old `/bin/bash` fallback is missing
   * on Alpine, where it answers 127 as well. `/bin/sh` is what POSIX requires to exist, and the line
   * is written to nothing beyond it.
   */
  private static readonly posixScriptedShellConst = '/bin/sh'

  static plan(record: SessionRecord, options?: LaunchPlanOptions): RuntimeLaunchSpec {
    const platform = options?.platform ?? process.platform
    const environment = options?.environment ?? process.env
    const common = {
      cwd: LaunchPlanner.cwdOf(record),
      env: {
        ...ChildEnvironment.withoutJamat(environment),
        [LaunchPlanner.sessionIdVariableConst]: record.sessionId,
        ...(options?.controller === undefined ? {} : {
          [LaunchPlanner.sessionControllerVariableConst]: options.controller.configIdentity,
          [LaunchPlanner.sessionChannelVariableConst]: options.controller.channel,
        }),
      },
      cols: options?.cols ?? LaunchPlanner.defaultColsConst,
      rows: options?.rows ?? LaunchPlanner.defaultRowsConst,
    }
    if (record.kind === 'shell') {
      if (record.commands !== undefined && record.commands.length > 0)
        return LaunchPlanner.scriptedShell(record.commands, platform, environment, common)
      return { command: LaunchPlanner.shellCommand(platform, environment), args: [], ...common }
    }
    else if (record.kind === 'agent') {
      const agent = record.agent
      if (!agent)
        throw new Error(`An agent session without an agent: ${JSON.stringify(record.sessionId)}`)
      const modeArgs = options?.agentArgs ?? AgentPresets.reopenArgs(agent)
      // In FRONT of the mode args: Codex reads `resume` and `fork` as subcommands, and a root option
      // after one of them is not a root option any more. The initial prompt stays where the presets
      // put it, last inside the mode args, so nothing here can be read as more prompt either.
      const front = [
        ...(options?.yolo ? LaunchPlanner.yoloArgsOf(agent.agentId, common.cwd) : []),
        ...(options?.model === undefined
          ? []
          : LaunchPlanner.modelArgsOf(agent.agentId, options.model)),
        ...(options?.effort === undefined
          ? []
          : LaunchPlanner.effortArgsOf(agent.agentId, options.effort)),
      ]
      const args = [...front, ...modeArgs]
      // The agents install as `.cmd` shims on Windows, which no spawn can execute directly; the
      // ComSpec wrap is what scripts/dev/probe-agent.ts proved against a real PTY.
      if (platform === 'win32')
        return {
          command: environment.ComSpec ?? 'cmd.exe',
          args: ['/d', '/q', '/c', agent.agentId, ...args],
          ...common,
        }
      return { command: agent.agentId, args, ...common }
    }
    else
      throw new Error(`Unknown session kind: ${JSON.stringify(record.kind)}`)
  }

  /**
   * What "ask me nothing" is, one agent at a time. Both CLIs keep the approval policy and the
   * directory's trust apart, so both are needed and neither flag implies the other.
   *
   * **Only Codex's trust is here.** Codex takes it as a process argument, so it belongs in the
   * function that builds arguments; Claude has no flag for it at all - `claude --help` says the
   * workspace trust dialog is skipped only when the run is non-interactive - so its trust is a write
   * into `~/.claude.json`, and that lives in `SessionLifecycle` rather than in this pure class.
   *
   * `JSON.stringify` is doing two jobs at once and both are wanted: it is the TOML basic-string
   * escape as well as the JSON one, and Codex's dotted `-c` splits on every dot in the path, which
   * is why the whole `projects` table is handed over inline instead.
   */
  private static yoloArgsOf(agentId: SessionRecordAgent['agentId'], cwd: string): string[] {
    if (agentId === 'claude')
      return ['--dangerously-skip-permissions']
    else if (agentId === 'codex')
      return [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`,
      ]
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /**
   * Which flag each agent names its model with. Read off the installed CLIs on 2026-08-19 rather
   * than assumed, the same way `AgentPresets` records its own: Claude Code 2.1.235 says
   * "--model <model> ... Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')
   * or a model's full name (e.g. 'claude-fable-5')", and Codex CLI 0.146.0 says
   * "-m, --model <MODEL> Model the agent should use".
   *
   * The value is not quoted or escaped here on purpose: `AgentSettings` already refuses anything
   * that could be read as a flag or acted on by cmd.exe, and this array is handed to a spawn rather
   * than to a shell.
   */
  private static modelArgsOf(agentId: SessionRecordAgent['agentId'], model: string): string[] {
    if (agentId === 'claude') return ['--model', model]
    else if (agentId === 'codex') return ['-m', model]
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /**
   * Measured 2026-08-24 against Claude Code 2.1.241 and Codex CLI 0.149.0. Claude names the flag
   * `--effort <level>` with "low, medium, high, xhigh, max" and IGNORES a level it does not know,
   * with a warning. Codex has no flag at all: the level is a config key, handed over inline, and
   * an unsupported one ends the run with a 400 before any work - which is why the tab offers
   * Codex only the levels of the model that was chosen.
   *
   * `JSON.stringify` is the TOML basic-string escape, the same job it does for the yolo trust
   * override two methods up. `AgentSettings` has already refused anything cmd.exe would act on.
   */
  private static effortArgsOf(agentId: SessionRecordAgent['agentId'], effort: string): string[] {
    if (agentId === 'claude') return ['--effort', effort]
    else if (agentId === 'codex')
      return ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`]
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /** A worktree is where the session actually runs; the directory it came from only names the repo. */
  static cwdOf(record: SessionRecord): string {
    return record.worktree?.worktreePath ?? LaunchPlanner.directoryOf(record.directory)
  }

  /**
   * The default resolves HERE, on the machine that runs the child, which is why it can name a real
   * folder. The client's own `SessionFolder.ofDirectory` answers the same three arms and returns
   * null for this one on purpose: it asks what path to DRAW, and the Host may be another machine,
   * so it has no home directory of the Host's to name.
   */
  static directoryOf(directory: SessionDirectoryRef): string {
    if (directory.mode === 'project') return directory.projectPath
    else if (directory.mode === 'adHoc') return directory.path
    else if (directory.mode === 'default') return homedir()
    else throw new Error(`Unknown session directory: ${JSON.stringify(directory)}`)
  }

  /**
   * Every step is introduced by its own `cd`, with no branch for "the directory the last step already
   * left us in": one shape to read in the terminal and one shape to test.
   *
   * **Nothing is joined with `&&`, and that is the whole point of the shape.** `&&` and `||` have
   * equal precedence and associate to the left, so a chain glued with `&&` lets a LATER step's own
   * operator decide the fate of an EARLIER step: `["pnpm install", "pnpm patch || true"]` became
   * `... && pnpm install && ... && pnpm patch || true`, which is `((...) || true)` - a failed install
   * exiting 0. Measured on real dash and on real cmd.exe, both answered exit 0.
   *
   * So each command is followed by its own guard - `|| exit $?` on POSIX, `|| exit /b` on win32 - and
   * the steps are glued with a plain terminator (`;` / `&`) that no operator can bind across. The
   * guard sits on the `cd` too, so a step's operator cannot reach back over the directory change this
   * library put there either. What the user's text can still decide is its OWN step, which is what
   * writing `|| true` in it means.
   *
   * The glue is a terminator rather than a newline on purpose: a `#` inside a POSIX step comments out
   * the rest of the LINE, so with `;` the whole remainder dies and the exit code is still the failing
   * step's, while with newlines only that step's guard would die and the next step would run and
   * report success.
   *
   * The directory is escaped and the command is not, and the asymmetry is deliberate: the command is
   * text from `.worktree.json` and is meant to be read as shell - its `$VAR`, its `%VAR%` and its own
   * `&&` all work - while the directory is data this library splices into shell syntax. Each platform
   * gets the escape its shell actually honours, and neither touches the command.
   *
   * **That text is not necessarily the user's**, which an earlier version of this comment assumed:
   * `.worktree.json` travels with a repository, and a clone dropped under a category root is a
   * project as far as the scanner is concerned. Escaping is not what answers that - a quoted command
   * still runs - so the answer is upstream, where `SessionLifecycle` refuses to start a setup this
   * machine has not agreed to. By the time a command reaches this planner, somebody has read it.
   *
   * On POSIX that data is single-quoted, because inside double quotes a shell still evaluates
   * `$(...)` and backticks - a project living in a directory named `x$(...)y` would execute it on the
   * way to `cd`. Single quotes have no such hole and every byte survives them through the `'\''`
   * escape. On win32 it is caret-escaped and NOT quoted, for the reason `caretEscaped` gives.
   *
   * **Grouping was measured and rejected, on win32.** Wrapping a step as `(cd /d X && <command>)`
   * would isolate it just as well until the command's own text carries a `)` - `echo hello)` closes
   * the group early - and cmd.exe answers the whole line with `) was unexpected at this time.`,
   * exit 1, before any step runs. The command text is deliberately not escaped, so that `)` is
   * reachable from `.worktree.json`; with no grouping cmd prints `hello)` and carries on.
   */
  private static scriptedShell(
    commands: readonly SessionRecordSetupCommand[],
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
    common: Omit<RuntimeLaunchSpec, 'command' | 'args'>,
  ): RuntimeLaunchSpec {
    if (platform === 'win32') {
      const line = commands
        .map((step) => `cd /d ${LaunchPlanner.caretEscaped(step.cwd)} || exit /b`
          + ` & ${step.command} || exit /b`)
        .join(' & ')
      return {
        command: LaunchPlanner.shellCommand(platform, environment),
        args: ['/d', '/q', '/c', line],
        ...common,
      }
    }
    const line = commands
      .map((step) => `cd ${LaunchPlanner.singleQuoted(step.cwd)} || exit $?`
        + `; ${step.command} || exit $?`)
      .join('; ')
    return { command: LaunchPlanner.posixScriptedShellConst, args: ['-c', line], ...common }
  }

  /** Closes the quote, hands the shell a literal `'`, opens it again - the total POSIX escape. */
  private static singleQuoted(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`
  }

  /**
   * cmd's own escape, and the only one that reaches it. **A quoted path can never survive the trip:**
   * node-pty builds the Windows command line by the MSVCRT convention (`argsToCommandLine` in
   * `windowsPtyAgent.js`), so a `"` inside one argument is handed to cmd.exe as `\"` - which cmd does
   * not understand. By its own `/C` rule it strips the first and the last quote of the line, and `cd`
   * is then given a literal `\"C:\...\"`. Measured through the Host's own node-pty: `cd /d "<path>"`
   * exits 1 with "The filename, directory name, or volume label syntax is incorrect", before a single
   * step of the install runs.
   *
   * So the directory goes in unquoted - which `cd /d` takes spaces and all, because it reads the rest
   * of the line up to the operator that follows it - and every character cmd would otherwise ACT on is
   * prefixed with `^`. `C:\R&D\thing` unescaped would split at the `&` and run `D\thing` as a command.
   * The caret passes node-pty untouched: its escaping only ever touches `"` and the backslashes in
   * front of one.
   *
   * `%` is deliberately not on the list, and this is the one thing that stays mangled: percent
   * expansion happens before caret processing, so nothing escapes it. An expanded path names a
   * directory that is not there, `cd /d` fails, its `|| exit /b` ends the line and the session exits
   * non-zero - which is the channel every setup failure already uses. `<`, `>` and `|` cannot occur in
   * a Windows path at all; they are escaped because this string also comes back off a record on disk.
   */
  private static caretEscaped(value: string): string {
    return value.replace(/[\^&|<>()]/g, (character) => `^${character}`)
  }

  /**
   * The interactive shell, which is why `$SHELL` is read here and only here: a session whose whole
   * job is to be the shell the user chose.
   *
   * A scripted line takes `posixScriptedShellConst` on POSIX and does NOT come through here. On
   * win32 it does: `scriptedShell` calls this for the `ComSpec` its `cmd /d /q /c` wrap needs, so a
   * change to the interactive choice on Windows changes the install shell with it.
   */
  private static shellCommand(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
    if (platform === 'win32') return environment.ComSpec ?? 'cmd.exe'
    return environment.SHELL ?? '/bin/bash'
  }
}
