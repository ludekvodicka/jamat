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
