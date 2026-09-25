/**
 * The environment a spawned child gets. Both methods share one invariant: **nothing of the running
 * process's own dev runtime or private integration configuration travels into a child.**
 *
 * A development AppClientUI is started by `electron-vite dev` under `pnpm run dev`, and both of those
 * write into the environment Electron then inherits: electron-vite's `resolveConfig` sets `NODE_ENV`
 * and `NODE_ENV_ELECTRON_VITE`, its `startElectron` spawns Electron with no `env` option at all, and
 * pnpm adds `NODE_PATH`, `npm_*`, `INIT_CWD` and the rest. A terminal that inherits them runs every
 * Node tool with the build tool's defaults without saying so - `next build` fails outright, and
 * `NODE_PATH` is worse because it says nothing: it points into electron-vite's own dependency tree,
 * so an import that should have failed can succeed and a different version of a package can load.
 *
 * The same holds for the agent session the client was started from, see `agentSessionNamesConst`.
 *
 * What the two methods differ about is Jamat's own variables, and the difference is who the child is:
 * the Host is ours and is TOLD which state root to serve, while everything else is a stranger that
 * must not find another generation's configuration.
 */
export class ChildEnvironment {
  /** Written by `electron-vite dev` and by `pnpm run dev`, and by nothing a user configures. */
  private static readonly devRuntimeNamesConst = [
    'NODE_ENV',
    'NODE_ENV_ELECTRON_VITE',
    'NODE_PATH',
    'INIT_CWD',
    'PNPM_SCRIPT_SRC_DIR',
    'PNPM_PACKAGE_NAME',
  ] as const

  /**
   * Uppercase because the comparison folds case. `PNPM_HOME` is deliberately NOT reachable from
   * here: it is profile configuration, and a child without it has no `pnpm` on its `PATH`.
   */
  private static readonly devRuntimePrefixesConst = ['NPM_', 'PNPM_CONFIG_', 'ELECTRON_'] as const

  private static readonly privateIntegrationPrefixesConst = ['RMCLI_'] as const

  private static readonly jamatPrefixConst = 'JAMAT'

  /**
   * Written by the agent session a client was STARTED from, never by a user's profile. A client
   * launched from a shell inside a Claude Code or Codex session must not hand that session's
   * identity, transcript switch, colour switch and bot git identity to every session it starts:
   * measured 2026-09-23, an inherited `CLAUDE_CODE_CHILD_SESSION` turned transcript saving off in
   * every Claude child, `NO_COLOR` took every TUI's colour, and the checkpoint bot's
   * `GIT_AUTHOR_*` would have signed the user's own commits. The Codex names were read off the
   * codex-cli 0.149 binary: the sandbox and network-proxy markers it sets for its child shells and
   * its session ids. `JAMAT_V3_SESSION_*` is listed for the Host, which keeps Jamat's own variables
   * but has no session of its own. User configuration stays: `ANTHROPIC_API_KEY`,
   * `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH` and the `CLAUDE_CODE_*` switches a user sets.
   * Exact names, compared case-folded like the dev runtime's.
   */
  private static readonly agentSessionNamesConst = [
    'CLAUDECODE',
    'CLAUDE_PID',
    'AI_AGENT',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP',
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'CODEX_NETWORK_PROXY_ACTIVE',
    'JAMAT_V3_SESSION_ID',
    'JAMAT_V3_SESSION_CONTROLLER',
    'JAMAT_V3_SESSION_CHANNEL',
    'NO_COLOR',
    'FORCE_COLOR',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_EDITOR',
    'GIT_TERMINAL_PROMPT',
    'GIT_ASKPASS',
    'GCM_INTERACTIVE',
  ] as const

  /** The Codex companion plugin's per-session transcript and id. */
  private static readonly agentSessionPrefixesConst = ['CODEX_COMPANION_'] as const

  /** Any one of these says the process runs inside an agent session. */
  private static readonly agentSessionMarkersConst = [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_SANDBOX',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
  ] as const

  /** The marker that says this environment belongs to an agent session, or null when none does. */
  static agentSessionMarkerOf(environment: NodeJS.ProcessEnv): string | null {
    return ChildEnvironment.agentSessionMarkersConst
      .find((name) => typeof environment[name] === 'string') ?? null
  }

  /** A child that is not Jamat's: a terminal, an agent, a CLI asked one question, a project hook. */
  static withoutJamat(environment: NodeJS.ProcessEnv): Record<string, string> {
    return ChildEnvironment.of(environment, 'drop')
  }

  /**
   * A child that IS Jamat's: the Host, which is handed its `JAMAT_V3_*` overrides on purpose.
   *
   * A caller that adds a variable of its own must add it AFTER this returns. `ELECTRON_` is a denied
   * prefix, so a switch spread in before the filter is filtered straight back out.
   */
  static keepingJamat(environment: NodeJS.ProcessEnv): Record<string, string> {
    return ChildEnvironment.of(environment, 'keep')
  }

  private static of(
    environment: NodeJS.ProcessEnv,
    jamat: 'keep' | 'drop',
  ): Record<string, string> {
    const dropsJamat = ChildEnvironment.dropsJamat(jamat)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value !== 'string') continue
      if (ChildEnvironment.isDevRuntime(key)) continue
      if (ChildEnvironment.isPrivateIntegration(key)) continue
      if (ChildEnvironment.isAgentSession(key)) continue
      // Case-SENSITIVE, unlike the line above, and on purpose: this clause is the rule that already
      // stood at every one of these call sites, moved rather than rewritten. The filter is `JAMAT`,
      // wider than the `JAMAT_V3_` prefix this tree reads, because a terminal opened inside V1 or V2
      // exports theirs and a stranger must inherit no Jamat variable at all.
      if (dropsJamat && key.startsWith(ChildEnvironment.jamatPrefixConst)) continue
      env[key] = value
    }
    return env
  }

  private static isDevRuntime(key: string): boolean {
    const name = key.toUpperCase()
    return ChildEnvironment.devRuntimeNamesConst.some((each) => each === name)
      || ChildEnvironment.devRuntimePrefixesConst.some((each) => name.startsWith(each))
  }

  private static isAgentSession(key: string): boolean {
    const name = key.toUpperCase()
    return ChildEnvironment.agentSessionNamesConst.some((each) => each === name)
      || ChildEnvironment.agentSessionPrefixesConst.some((each) => name.startsWith(each))
  }

  private static isPrivateIntegration(key: string): boolean {
    const name = key.toUpperCase()
    return ChildEnvironment.privateIntegrationPrefixesConst.some((each) => name.startsWith(each))
  }

  private static dropsJamat(jamat: 'keep' | 'drop'): boolean {
    if (jamat === 'drop') return true
    else if (jamat === 'keep') return false
    else throw new Error(`Unknown Jamat variable policy: ${JSON.stringify(jamat)}`)
  }
}
