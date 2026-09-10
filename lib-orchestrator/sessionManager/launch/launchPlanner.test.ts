import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SessionRecord } from '../records/sessionRecord.types'
import { AgentPresets } from './agentPresets'
import { LaunchPlanner } from './launchPlanner'

describe('lib-orchestrator/sessionManager/launch/launchPlanner', () => {
  const environmentConst: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    SHELL: '/bin/zsh',
    PNPM_HOME: 'C:\\pnpm',
    NODE_ENV: 'development',
    NODE_PATH: 'Q:\\...\\electron-vite\\node_modules',
    ELECTRON_RENDERER_URL: 'http://localhost:5173',
    npm_package_name: 'jamat-v3-client-ui',
    INIT_CWD: 'C:\\Projects\\NodeJs\\AppJamatV3',
    JAMAT_V3_CONFIG_DIR: 'Q:\\v3',
    JAMAT_CONFIG_DIR: 'Q:\\v1',
    JAMATANYTHING: 'x',
  }

  function record(overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'shell',
      title: 's1',
      directory: { mode: 'adHoc', path: 'D:\\work' },
      binding: null,
      life: 'starting',
      createdAt: 1,
      ...overrides,
    }
  }

  function plan(value: SessionRecord, platform: NodeJS.Platform, agentArgs?: string[]) {
    return LaunchPlanner.plan(value, { platform, environment: environmentConst, agentArgs })
  }

  it('runs a shell through the platform shell', () => {
    expect(plan(record(), 'win32').command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(plan(record(), 'win32').args).toEqual([])
    expect(plan(record(), 'linux').command).toBe('/bin/zsh')
  })

  it('exports the session and its controller after removing inherited Jamat variables', () => {
    for (const value of [record(), record({ kind: 'agent', agent: { agentId: 'codex', launchMode: 'new' } })]) {
      const launch = LaunchPlanner.plan(value, {
        agentArgs: [],
        environment: { PATH: 'x', JAMAT_CONFIG_DIR: 'old', JAMAT_V3_SESSION_ID: 'parent' },
        controller: { configIdentity: 'cfg-1', channel: 'development' },
      })
      expect(launch.env).toEqual({
        PATH: 'x', JAMAT_V3_SESSION_ID: 's1',
        JAMAT_V3_SESSION_CONTROLLER: 'cfg-1', JAMAT_V3_SESSION_CHANNEL: 'development',
      })
    }
  })

  it('falls back to a shell that exists when the environment names none', () => {
    expect(LaunchPlanner.plan(record(), { platform: 'win32', environment: {} }).command)
      .toBe('cmd.exe')
    expect(LaunchPlanner.plan(record(), { platform: 'darwin', environment: {} }).command)
      .toBe('/bin/bash')
  })

  it('scripts a shell that carries commands, one guarded cd per step, on both platforms', () => {
    const setup = record({
      directory: { mode: 'adHoc', path: 'Q:\\apps\\one\\.worktrees\\fix' },
      commands: [
        { command: 'pnpm install', cwd: 'Q:\\apps\\one\\.worktrees\\fix' },
        { command: 'uv sync', cwd: 'Q:\\apps\\one\\.worktrees\\fix\\api service' },
      ],
    })
    const windows = plan(setup, 'win32')
    expect(windows.command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(windows.args).toEqual(['/d', '/q', '/c',
      'cd /d Q:\\apps\\one\\.worktrees\\fix || exit /b & pnpm install || exit /b'
      + ' & cd /d Q:\\apps\\one\\.worktrees\\fix\\api service || exit /b & uv sync || exit /b'])
    const posix = plan(setup, 'linux')
    expect(posix.args).toEqual(['-c',
      "cd 'Q:\\apps\\one\\.worktrees\\fix' || exit $?; pnpm install || exit $?"
      + "; cd 'Q:\\apps\\one\\.worktrees\\fix\\api service' || exit $?; uv sync || exit $?"])
  })

  /*
   * The defect this shape exists for. `&&` and `||` have equal precedence and associate to the left,
   * so a chain glued with `&&` hands a LATER step's operator the fate of an EARLIER one: the second
   * step's `|| true` used to cover the whole line, and a failed `pnpm install` exited 0. Measured on
   * real dash and on real cmd.exe as exit 0 with the tolerated branch taken.
   *
   * The guard after each command is what the glue can no longer be reached across. Whether it really
   * cannot is proved by the two EXECUTES tests at the end of this file, not by this one.
   */
  it('gives every step its own guard, so a later step cannot tolerate an earlier failure', () => {
    const setup = record({
      directory: { mode: 'adHoc', path: '/wt' },
      commands: [
        { command: 'pnpm install', cwd: '/wt' },
        { command: 'pnpm patch-apply || true', cwd: '/wt' },
      ],
    })
    expect(plan(setup, 'linux').args[1]).toBe(
      "cd '/wt' || exit $?; pnpm install || exit $?"
      + "; cd '/wt' || exit $?; pnpm patch-apply || true || exit $?")
    expect(plan(setup, 'win32').args[3]).toBe(
      'cd /d /wt || exit /b & pnpm install || exit /b'
      + ' & cd /d /wt || exit /b & pnpm patch-apply || true || exit /b')
  })

  /*
   * `$SHELL` is the user's LOGIN shell. It is the right answer for the terminal a person types in and
   * the wrong one for a line this class wrote: fish refuses it outright (`$? is not the exit status`,
   * exit 127, nothing of the install runs) and the old `/bin/bash` fallback is absent on Alpine, which
   * answers 127 too. Both measured in containers. `/bin/sh` is the one POSIX guarantees.
   */
  it('runs a scripted POSIX line under /bin/sh and an interactive one under the login shell', () => {
    const setup = record({
      directory: { mode: 'adHoc', path: '/wt' },
      commands: [{ command: 'pnpm install', cwd: '/wt' }],
    })
    expect(plan(setup, 'linux').command).toBe('/bin/sh')
    expect(LaunchPlanner.plan(setup, { platform: 'linux', environment: {} }).command).toBe('/bin/sh')
    expect(plan(record(), 'linux').command).toBe('/bin/zsh')
  })

  // A setup record carries no worktree field on purpose: cwdOf must not overwrite the directory the
  // first step installs in.
  it('starts a scripted shell in the directory its record names', () => {
    const setup = record({
      directory: { mode: 'adHoc', path: 'Q:\\wt\\api' },
      commands: [{ command: 'uv sync', cwd: 'Q:\\wt\\api' }],
    })
    expect(plan(setup, 'win32').cwd).toBe('Q:\\wt\\api')
    expect(LaunchPlanner.cwdOf(setup)).toBe('Q:\\wt\\api')
  })

  /*
   * No record the store accepts can arrive here saying this: `commandsProblem` refuses an empty list
   * on the way in and on the way out. The guard is the other half of that agreement rather than a
   * blessing of the shape - scripting an empty list would be a shell that exits 0 having installed
   * nothing, which is the one outcome worse than an interactive one.
   */
  it('never scripts a command list with nothing in it', () => {
    const empty = record({ commands: [], setupFor: 'p1' })
    expect(plan(empty, 'win32').args).toEqual([])
    expect(plan(empty, 'linux').args).toEqual([])
    expect(plan(empty, 'linux').command).toBe('/bin/zsh')
  })

  it('ignores commands on an agent record', () => {
    const agent = record({
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'resume', nativeSessionId: 'n1' },
      commands: [{ command: 'pnpm install', cwd: 'Q:\\wt' }],
    })
    expect(plan(agent, 'linux').command).toBe('claude')
    expect(plan(agent, 'linux').args).toEqual(['--resume', 'n1'])
  })

  // Inside double quotes a POSIX shell still evaluates $(...) and backticks, so a project living in a
  // directory named one of those would execute it on the way to cd. Single quotes close that.
  it('hands a POSIX directory to cd as literal text, however it is named', () => {
    const substitution = '/home/x$(whoami)`id`/wt'
    expect(plan(record({
      directory: { mode: 'adHoc', path: substitution },
      commands: [{ command: 'pnpm install', cwd: substitution }],
    }), 'linux').args[1])
      .toBe("cd '/home/x$(whoami)`id`/wt' || exit $?; pnpm install || exit $?")

    const quotes = `/home/o'brien/a"b/wt`
    expect(plan(record({
      directory: { mode: 'adHoc', path: quotes },
      commands: [{ command: 'pnpm install', cwd: quotes }],
    }), 'linux').args[1])
      .toBe(`cd '/home/o'\\''brien/a"b/wt' || exit $?; pnpm install || exit $?`)
  })

  // The other half of the asymmetry: the command is the user's own text from .worktree.json and is
  // meant to be read as shell, so it is never escaped on either platform - its own && included.
  it('leaves the command as shell text while the directory is escaped', () => {
    expect(plan(record({
      directory: { mode: 'adHoc', path: '/wt' },
      commands: [{ command: 'pnpm install --store "$PNPM_HOME"', cwd: '/wt' }],
    }), 'linux').args[1])
      .toBe(`cd '/wt' || exit $?; pnpm install --store "$PNPM_HOME" || exit $?`)

    expect(plan(record({
      directory: { mode: 'adHoc', path: 'Q:\\wt' },
      commands: [{ command: 'pnpm i --store %PNPM_HOME% && pnpm build', cwd: 'Q:\\wt' }],
    }), 'win32').args[3])
      .toBe('cd /d Q:\\wt || exit /b & pnpm i --store %PNPM_HOME% && pnpm build || exit /b')
  })

  /*
   * The win32 directory is NOT quoted, and it cannot be: node-pty writes the command line by the
   * MSVCRT convention, so an inner `"` reaches cmd.exe as `\"`, cmd strips only the outermost pair
   * and cd is handed a literal backslash-quote. Measured through the Host's own node-pty: the quoted
   * form exits 1 before any step runs. Unquoted, cd /d takes the rest of the line - spaces and all -
   * and the caret is what stops cmd acting on the rest.
   */
  it('escapes a win32 directory with carets instead of quoting it', () => {
    const win32Cwd = (cwd: string): string =>
      plan(record({
        directory: { mode: 'adHoc', path: cwd },
        commands: [{ command: 'pnpm install', cwd }],
      }), 'win32').args[3]

    expect(win32Cwd('Q:\\apps\\api service\\wt'))
      .toBe('cd /d Q:\\apps\\api service\\wt || exit /b & pnpm install || exit /b')
    // Unescaped, cmd would split the line at the & and run `D\wt` as a command of its own.
    expect(win32Cwd('Q:\\R&D\\wt')).toBe('cd /d Q:\\R^&D\\wt || exit /b & pnpm install || exit /b')
    expect(win32Cwd('Q:\\ca^ret\\wt'))
      .toBe('cd /d Q:\\ca^^ret\\wt || exit /b & pnpm install || exit /b')
    expect(win32Cwd('Q:\\pa(re)n\\wt'))
      .toBe('cd /d Q:\\pa^(re^)n\\wt || exit /b & pnpm install || exit /b')
    expect(win32Cwd('Q:\\R&D\\a^b\\(c)\\wt'))
      .toBe('cd /d Q:\\R^&D\\a^^b\\^(c^)\\wt || exit /b & pnpm install || exit /b')
  })

  // The one thing no escape reaches: cmd expands %VAR% before it processes carets. The path goes
  // through as written, the expansion names a directory that is not there, cd /d fails and the
  // session exits non-zero, which is the visible failure every setup error already takes.
  it('hands a percent sign in a directory to the shell unchanged', () => {
    const odd = record({
      directory: { mode: 'adHoc', path: 'Q:\\build%TEMP%\\wt' },
      commands: [{ command: 'pnpm install', cwd: 'Q:\\build%TEMP%\\wt' }],
    })
    expect(plan(odd, 'win32').args[3])
      .toBe('cd /d Q:\\build%TEMP%\\wt || exit /b & pnpm install || exit /b')
  })

  // The agents install as .cmd shims on Windows, which no spawn can execute directly.
  it('wraps an agent in ComSpec on win32 and spawns it directly everywhere else', () => {
    const agent = record({
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'resume', nativeSessionId: 'n1' },
    })
    const wrapped = plan(agent, 'win32')
    expect(wrapped.command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(wrapped.args).toEqual(['/d', '/q', '/c', 'claude', '--resume', 'n1'])
    const direct = plan(agent, 'linux')
    expect(direct.command).toBe('claude')
    expect(direct.args).toEqual(['--resume', 'n1'])
  })

  it('takes the args a create asked for, and the resume shape when none are given', () => {
    const agent = record({
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'resume', nativeSessionId: 'n1' },
    })
    expect(plan(agent, 'linux', ['--session-id', 'n1']).args).toEqual(['--session-id', 'n1'])
    expect(plan(agent, 'linux').args).toEqual(['--resume', 'n1'])
  })

  describe('yolo', () => {
    const modesConst = ['new', 'continue', 'resume', 'fork'] as const

    function agentRecord(agentId: 'claude' | 'codex', cwd = 'D:\\work'): SessionRecord {
      return record({
        kind: 'agent',
        directory: { mode: 'adHoc', path: cwd },
        agent: { agentId, launchMode: 'resume', nativeSessionId: 'n1' },
      })
    }

    function yoloPlan(value: SessionRecord, platform: NodeJS.Platform, agentArgs?: string[]) {
      return LaunchPlanner.plan(value, {
        platform,
        environment: environmentConst,
        agentArgs,
        yolo: true,
      })
    }

    function trustOf(cwd: string): string {
      return `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`
    }

    it('leaves every launch bit for bit as it is when nobody asked for it', () => {
      for (const agentId of ['claude', 'codex'] as const)
        for (const platform of ['win32', 'linux'] as const) {
          const value = agentRecord(agentId)
          expect(LaunchPlanner.plan(value, {
            platform,
            environment: environmentConst,
            yolo: false,
          })).toEqual(plan(value, platform))
        }
    })

    it('puts the flags ahead of every mode, on both platforms, and keeps the prompt last', () => {
      for (const agentId of ['claude', 'codex'] as const) {
        const prefix = agentId === 'claude'
          ? ['--dangerously-skip-permissions']
          : ['--dangerously-bypass-approvals-and-sandbox', '-c', trustOf('D:\\work')]
        for (const mode of modesConst) {
          const modeArgs = AgentPresets.createArgs(
            { agentId, mode, nativeSessionId: 'n1', forkParentId: 'p1', initialPrompt: 'hello' },
            'n1',
          )
          const value = agentRecord(agentId)
          expect(yoloPlan(value, 'linux', modeArgs).args).toEqual([...prefix, ...modeArgs])
          expect(yoloPlan(value, 'win32', modeArgs).args)
            .toEqual(['/d', '/q', '/c', agentId, ...prefix, ...modeArgs])
          expect(yoloPlan(value, 'linux', modeArgs).args.at(-1)).toBe('hello')
        }
      }
    })

    // Both are Codex subcommands, and a root option written after one is not a root option.
    it('keeps the Codex flags in front of its resume and fork subcommands', () => {
      for (const modeArgs of [['resume', 'n1'], ['fork', 'p1'], ['resume', '--last']]) {
        const args = yoloPlan(agentRecord('codex'), 'linux', modeArgs).args
        expect(args.indexOf('--dangerously-bypass-approvals-and-sandbox'))
          .toBeLessThan(args.indexOf(modeArgs[0]))
        expect(args.indexOf('-c')).toBeLessThan(args.indexOf(modeArgs[0]))
      }
    })

    it('trusts the directory the session actually runs in, worktree included', () => {
      const worktree = record({
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'resume', nativeSessionId: 'n1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: 'Q:\\apps\\one' },
        worktree: {
          worktreePath: 'Q:\\apps\\one\\.worktrees\\fix',
          branch: 'jamat/fix',
          baseCommit: 'abc123',
          repositoryRoot: 'Q:\\apps\\one',
        },
      })
      expect(yoloPlan(worktree, 'linux').args)
        .toContain(trustOf('Q:\\apps\\one\\.worktrees\\fix'))
    })

    /*
     * `JSON.stringify` is the TOML basic-string escape as well as the JSON one, which is the whole
     * reason the override is built with it. A backslash and a quote are what a Windows path and a
     * hostile directory name bring; a dot is what broke the dotted `-c` form this replaced.
     */
    it('escapes a directory that would otherwise end the TOML string', () => {
      const cases = [
        ['D:\\a b\\c', 'projects={"D:\\\\a b\\\\c"={trust_level="trusted"}}'],
        ["D:\\it's\\x", 'projects={"D:\\\\it\'s\\\\x"={trust_level="trusted"}}'],
        ['D:\\a.b.c\\x', 'projects={"D:\\\\a.b.c\\\\x"={trust_level="trusted"}}'],
        ['D:\\say "hi"', 'projects={"D:\\\\say \\"hi\\""={trust_level="trusted"}}'],
      ] as const
      for (const [cwd, expected] of cases)
        expect(yoloPlan(agentRecord('codex', cwd), 'win32').args).toContain(expected)
    })

    it('never reaches a shell, scripted or interactive', () => {
      const interactive = record()
      const scripted = record({
        commands: [{ command: 'pnpm install', cwd: 'D:\\work' }],
      })
      for (const value of [interactive, scripted])
        for (const platform of ['win32', 'linux'] as const)
          expect(yoloPlan(value, platform)).toEqual(plan(value, platform))
    })

    it('refuses an agent it has no policy for', () => {
      const unknown = record({
        kind: 'agent',
        agent: {
          agentId: 'gemini' as never,
          launchMode: 'resume',
          nativeSessionId: 'n1',
        },
      })
      expect(() => yoloPlan(unknown, 'linux', ['--resume', 'n1'])).toThrow('Unknown agent')
    })
  })

  it('resolves the working directory from the directory reference', () => {
    expect(plan(record({ directory: { mode: 'adHoc', path: 'D:\\work' } }), 'win32').cwd)
      .toBe('D:\\work')
    expect(plan(record({
      directory: { mode: 'project', categoryId: 'c1', projectPath: 'Q:\\apps\\one' },
    }), 'win32').cwd).toBe('Q:\\apps\\one')
    expect(plan(record({ directory: { mode: 'default' } }), 'win32').cwd).toBe(homedir())
  })

  it('runs an agent inside its worktree, not inside the project it was branched from', () => {
    const worktree = record({
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'resume', nativeSessionId: 'n1' },
      directory: { mode: 'project', categoryId: 'c1', projectPath: 'Q:\\apps\\one' },
      worktree: {
        worktreePath: 'Q:\\apps\\one\\.worktrees\\fix',
        branch: 'jamat/fix',
        baseCommit: 'abc123',
        repositoryRoot: 'Q:\\apps\\one',
      },
    })
    expect(plan(worktree, 'linux').cwd).toBe('Q:\\apps\\one\\.worktrees\\fix')
    expect(LaunchPlanner.cwdOf(worktree)).toBe('Q:\\apps\\one\\.worktrees\\fix')
  })

  // A terminal opened inside V1 or V2 exports their variables, and the agent must inherit none.
  // The dev runtime is the second half of the same rule: a development client is started by
  // electron-vite under pnpm, and an agent that inherits THAT runs every Node tool with the build
  // tool's defaults - which is what broke `next build` in a Jamat terminal.
  it('hands over the environment except every JAMAT key and the dev runtime', () => {
    const env = plan(record(), 'win32').env
    expect(env.PATH).toBe('/usr/bin')
    expect(env.PNPM_HOME).toBe('C:\\pnpm')
    expect(Object.keys(env).filter((key) => key.startsWith('JAMAT'))).toEqual(['JAMAT_V3_SESSION_ID'])
    expect(env.JAMAT_V3_SESSION_ID).toBe('s1')
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.ELECTRON_RENDERER_URL).toBeUndefined()
    expect(env.npm_package_name).toBeUndefined()
    expect(env.INIT_CWD).toBeUndefined()
  })

  // The planner reads ComSpec and SHELL itself to pick the shell, so a filter that ate either would
  // answer with a session that cannot start at all.
  it('leaves the variables the planner itself reads alone', () => {
    expect(plan(record(), 'win32').command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(plan(record(), 'linux').command).toBe('/bin/zsh')
  })

  it('defaults to 120x30 and takes a size when it is given one', () => {
    const planned = plan(record(), 'win32')
    expect(planned.cols).toBe(120)
    expect(planned.rows).toBe(30)
    const sized = LaunchPlanner.plan(record(), { cols: 80, rows: 24, environment: environmentConst })
    expect({ cols: sized.cols, rows: sized.rows }).toEqual({ cols: 80, rows: 24 })
  })

  /*
   * The only tests in this file that RUN what plan() emits. Every other assertion here compares a
   * string to the escape the code applies, which is bit for bit how the win32 branch once shipped
   * completely dead - the defect was a layer below the string, and the green suite said nothing.
   *
   * One of the two runs on this machine and the other is skipped, so the branch this platform is not
   * on stays unproved BY THIS FILE, and the skip is the honest way of saying so.
   */
  describe('EXECUTES the planned line through a real shell', () => {
    const traceConst = 'step-two-ran.txt'
    let directory = ''

    beforeAll(() => {
      // The real path, because the planned line carries the directory as TEXT: on Windows
      // os.tmpdir() can answer with an 8.3 short name that not every spawn accepts.
      directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-v3-launch-planner-')))
      writeFileSync(join(directory, 'code.cjs'), 'process.exit(Number(process.argv[2]))\n', 'utf8')
      writeFileSync(join(directory, 'touch.cjs'),
        "require('node:fs').writeFileSync(process.argv[2], process.cwd())\n", 'utf8')
    })
    afterAll(() => {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    /** Plans for THIS platform and this environment, then runs exactly what it planned. */
    function execute(commands: string[]): number | null {
      rmSync(join(directory, traceConst), { force: true })
      const planned = LaunchPlanner.plan(record({
        directory: { mode: 'adHoc', path: directory },
        commands: commands.map((command) => ({ command, cwd: directory })),
      }))
      return spawnSync(planned.command, planned.args,
        { cwd: planned.cwd, env: planned.env, encoding: 'utf8' }).status
    }

    it.runIf(process.platform === 'win32')(
      'EXECUTES it on win32: a failed first step ends the install with its own code', () => {
        expect(execute([
          'node code.cjs 7',
          `node touch.cjs ${traceConst} || echo tolerated`,
        ])).toBe(7)
        expect(existsSync(join(directory, traceConst))).toBe(false)

        expect(execute(['node code.cjs 0', `node touch.cjs ${traceConst}`])).toBe(0)
        expect(existsSync(join(directory, traceConst))).toBe(true)
        // Which is also the proof that the escaped `cd` put the step where the record said.
        expect(readFileSync(join(directory, traceConst), 'utf8')).toBe(directory)

        // The command text is not escaped, so a `)` in it reaches cmd. Parenthesised grouping would
        // close early on it and answer `) was unexpected at this time.` before any step runs.
        expect(execute(['echo paren) here', `node touch.cjs ${traceConst}`])).toBe(0)
        expect(existsSync(join(directory, traceConst))).toBe(true)
      })

    it.runIf(process.platform !== 'win32')(
      'EXECUTES it on POSIX: a failed first step ends the install with its own code', () => {
        expect(execute([
          'node code.cjs 7',
          `node touch.cjs ${traceConst} || true`,
        ])).toBe(7)
        expect(existsSync(join(directory, traceConst))).toBe(false)

        expect(execute(['node code.cjs 0', `node touch.cjs ${traceConst}`])).toBe(0)
        expect(existsSync(join(directory, traceConst))).toBe(true)
        expect(readFileSync(join(directory, traceConst), 'utf8')).toBe(directory)

        expect(execute(['node code.cjs 0 ; echo tail', `node touch.cjs ${traceConst}`])).toBe(0)
        expect(existsSync(join(directory, traceConst))).toBe(true)
      })
  })

  it('throws on a kind, a directory or an agent session it cannot plan', () => {
    expect(() => plan(record({ kind: 'tmux' as SessionRecord['kind'] }), 'win32'))
      .toThrow(/Unknown session kind/)
    expect(() => plan(record({
      directory: { mode: 'elsewhere' } as unknown as SessionRecord['directory'],
    }), 'win32')).toThrow(/Unknown session directory/)
    expect(() => plan(record({ kind: 'agent' }), 'win32'))
      .toThrow(/agent session without an agent/)
  })

  describe('model', () => {
    const modesConst = ['new', 'continue', 'resume', 'fork'] as const

    function agentRecord(agentId: 'claude' | 'codex'): SessionRecord {
      return record({
        kind: 'agent',
        directory: { mode: 'adHoc', path: 'D:\\work' },
        agent: { agentId, launchMode: 'resume', nativeSessionId: 'n1' },
      })
    }

    function modelPlan(
      value: SessionRecord,
      platform: NodeJS.Platform,
      model?: string,
      agentArgs?: string[],
      yolo?: boolean,
    ) {
      return LaunchPlanner.plan(value, {
        platform,
        environment: environmentConst,
        agentArgs,
        model,
        yolo,
      })
    }

    it('leaves every launch bit for bit as it is when nobody named a model', () => {
      for (const agentId of ['claude', 'codex'] as const)
        for (const platform of ['win32', 'linux'] as const) {
          const value = agentRecord(agentId)
          expect(modelPlan(value, platform)).toEqual(plan(value, platform))
          expect(modelPlan(value, platform, undefined)).toEqual(plan(value, platform))
        }
    })

    it('names the model with the flag its own agent uses, on both platforms', () => {
      for (const [agentId, expected] of [
        ['claude', ['--model', 'claude-fable-5']],
        ['codex', ['-m', 'gpt-5.6-sol']],
      ] as const) {
        const value = agentRecord(agentId)
        expect(modelPlan(value, 'linux', expected[1]).args.slice(0, 2)).toEqual([...expected])
        expect(modelPlan(value, 'win32', expected[1]).args.slice(0, 6))
          .toEqual(['/d', '/q', '/c', agentId, ...expected])
      }
    })

    // The whole reason the front block exists: Codex reads `resume` and `fork` as subcommands, and a
    // root option after one of them is not a root option any more.
    it('puts the model ahead of every mode and keeps the prompt last', () => {
      for (const agentId of ['claude', 'codex'] as const) {
        const prefix = agentId === 'claude' ? ['--model', 'opus'] : ['-m', 'opus']
        for (const mode of modesConst) {
          const modeArgs = AgentPresets.createArgs(
            { agentId, mode, nativeSessionId: 'n1', forkParentId: 'p1', initialPrompt: 'hello' },
            'n1',
          )
          const value = agentRecord(agentId)
          expect(modelPlan(value, 'linux', 'opus', modeArgs).args)
            .toEqual([...prefix, ...modeArgs])
          expect(modelPlan(value, 'win32', 'opus', modeArgs).args)
            .toEqual(['/d', '/q', '/c', agentId, ...prefix, ...modeArgs])
          expect(modelPlan(value, 'linux', 'opus', modeArgs).args.at(-1)).toBe('hello')
        }
        const resumeArgs = AgentPresets.createArgs(
          { agentId, mode: 'resume', nativeSessionId: 'n1' },
          undefined,
        )
        const args = modelPlan(agentRecord(agentId), 'linux', 'opus', resumeArgs).args
        if (agentId === 'codex') expect(args.indexOf('-m')).toBeLessThan(args.indexOf('resume'))
      }
    })

    it('keeps yolo and the model together in front, yolo first', () => {
      const modeArgs = AgentPresets.createArgs(
        { agentId: 'codex', mode: 'fork', forkParentId: 'p1', initialPrompt: 'hello' },
        undefined,
      )
      const args = modelPlan(agentRecord('codex'), 'linux', 'gpt-5.5', modeArgs, true).args
      expect(args).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', `projects={${JSON.stringify('D:\\work')}={trust_level="trusted"}}`,
        '-m', 'gpt-5.5',
        ...modeArgs,
      ])
      expect(args.at(-1)).toBe('hello')
    })

    it('refuses an agent it has no flag for rather than guessing one', () => {
      const unknown = record({
        kind: 'agent',
        agent: {
          agentId: 'gemini' as never,
          launchMode: 'resume',
          nativeSessionId: 'n1',
        },
      })
      expect(() => modelPlan(unknown, 'linux', 'x', ['--resume', 'n1'])).toThrow('Unknown agent')
    })

    // A model belongs to an agent. A setup shell that somehow received one must not grow a flag.
    it('ignores a model on a shell session', () => {
      expect(modelPlan(record(), 'linux', 'opus')).toEqual(plan(record(), 'linux'))
    })
  })

  describe('effort', () => {
    function agentRecord(agentId: 'claude' | 'codex'): SessionRecord {
      return record({
        kind: 'agent',
        directory: { mode: 'adHoc', path: 'D:\\work' },
        agent: { agentId, launchMode: 'resume', nativeSessionId: 'n1' },
      })
    }

    function effortPlan(
      value: SessionRecord,
      platform: NodeJS.Platform,
      effort?: string,
      agentArgs?: string[],
      model?: string,
      yolo?: boolean,
    ) {
      return LaunchPlanner.plan(value, {
        platform,
        environment: environmentConst,
        agentArgs,
        effort,
        model,
        yolo,
      })
    }

    it('leaves every launch bit for bit as it is when nobody named an effort', () => {
      for (const agentId of ['claude', 'codex'] as const)
        for (const platform of ['win32', 'linux'] as const) {
          const value = agentRecord(agentId)
          expect(effortPlan(value, platform)).toEqual(plan(value, platform))
          expect(effortPlan(value, platform, undefined)).toEqual(plan(value, platform))
        }
    })

    // Claude has a flag; Codex has only a config key, which is why the two shapes differ.
    it('names the effort the way its own agent takes one, on both platforms', () => {
      for (const [agentId, expected] of [
        ['claude', ['--effort', 'high']],
        ['codex', ['-c', 'model_reasoning_effort="high"']],
      ] as const) {
        const value = agentRecord(agentId)
        expect(effortPlan(value, 'linux', 'high').args.slice(0, 2)).toEqual([...expected])
        expect(effortPlan(value, 'win32', 'high').args.slice(0, 6))
          .toEqual(['/d', '/q', '/c', agentId, ...expected])
      }
    })

    it('keeps yolo, the model and the effort together in front, and the prompt last', () => {
      const modeArgs = AgentPresets.createArgs(
        { agentId: 'codex', mode: 'fork', forkParentId: 'p1', initialPrompt: 'hello' },
        undefined,
      )
      const args = effortPlan(
        agentRecord('codex'), 'linux', 'xhigh', modeArgs, 'gpt-5.5', true,
      ).args
      expect(args).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', `projects={${JSON.stringify('D:\\work')}={trust_level="trusted"}}`,
        '-m', 'gpt-5.5',
        '-c', 'model_reasoning_effort="xhigh"',
        ...modeArgs,
      ])
      expect(args.at(-1)).toBe('hello')
      // Codex reads `fork` as a subcommand, so every root option has to sit before it.
      expect(args.lastIndexOf('-c')).toBeLessThan(args.indexOf('fork'))
    })

    it('carries an effort with no model, because the agent still has a default to think on', () => {
      expect(effortPlan(agentRecord('claude'), 'linux', 'max').args.slice(0, 2))
        .toEqual(['--effort', 'max'])
    })

    it('refuses an agent it has no flag for rather than guessing one', () => {
      const unknown = record({
        kind: 'agent',
        agent: { agentId: 'gemini' as never, launchMode: 'resume', nativeSessionId: 'n1' },
      })
      expect(() => effortPlan(unknown, 'linux', 'high', ['--resume', 'n1'])).toThrow('Unknown agent')
    })

    it('ignores an effort on a shell session', () => {
      expect(effortPlan(record(), 'linux', 'high')).toEqual(plan(record(), 'linux'))
    })
  })
})
