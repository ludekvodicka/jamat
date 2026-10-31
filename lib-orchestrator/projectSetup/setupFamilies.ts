import type { PlatformSettingsValue, SetupFamilyId, SetupToolId } from './projectSetup.types'

/** One tool of a family: what picks it, and what it runs with default options. */
export interface SetupFamilyTool {
  toolId: SetupToolId
  /** What decides it, in the words the overview prints. */
  marker: string
  command: string
}

export interface SetupFamily {
  familyId: SetupFamilyId
  title: string
  tools: readonly SetupFamilyTool[]
}

/**
 * Which command installs which family, and what picks it. The one place both sides read.
 *
 * **Deliberately web-safe, and a VALUE import the renderer takes out of this library**
 * (`CLAUDE.md` rule 1), for the same reason `worktreeNaming` and `sessionLimits` are: the settings
 * window prints what a family installs and this decides what actually runs, so a table retyped over
 * there is a table that disagrees the first time a default changes. It has no imports of its own
 * beyond the types beside it, which is what keeps `node:` out of the web program.
 *
 * The markers are prose for the overview and not the detection rule. The rule lives in each
 * detector and is richer than one line - node reads a `packageManager` field before any lockfile
 * and walks up to a workspace root - so the column says what a person looks for, not what the code
 * does.
 */
export class SetupFamilies {
  /**
   * The pnpm option this machine can turn on, as the variable that carries it. A variable and not
   * `--config.enableGlobalVirtualStore=true` on the install line, because the option has to hold for
   * every later pnpm command in the worktree too: pnpm 12 checks dependencies before `pnpm exec` and
   * `pnpm run` and reinstalls without the option it does not see. Measured 2026-10-30 with pnpm
   * 12.8.1: `pnpm exec next dev` rewrote `node_modules` from 145 to 75,977 hard-linked entries in
   * 30.6 s, while an install with this variable took 20 ms and kept the store. pnpm reads only the
   * `pnpm_config_` spelling; `npm_config_enable_global_virtual_store` is ignored.
   */
  static readonly pnpmGlobalVirtualStoreVariableConst = 'pnpm_config_enable_global_virtual_store'

  static readonly catalogConst: readonly SetupFamily[] = [
    {
      familyId: 'node',
      title: 'node',
      tools: [
        { toolId: 'node-pnpm', marker: 'pnpm-lock.yaml', command: 'pnpm install' },
        { toolId: 'node-npm', marker: 'package-lock.json', command: 'npm install' },
        { toolId: 'node-yarn', marker: 'yarn.lock', command: 'yarn install' },
      ],
    },
    {
      familyId: 'python',
      title: 'python',
      tools: [
        { toolId: 'python-uv', marker: 'uv.lock', command: 'uv sync' },
        { toolId: 'python-poetry', marker: 'poetry.lock', command: 'poetry install' },
      ],
    },
    {
      familyId: 'rust',
      title: 'rust',
      tools: [{ toolId: 'rust-cargo', marker: 'Cargo.toml', command: 'cargo fetch' }],
    },
    {
      familyId: 'go',
      title: 'go',
      tools: [{ toolId: 'go-mod', marker: 'go.mod', command: 'go mod download' }],
    },
  ]

  /**
   * What this machine answers before anybody has set anything: a plain install of every family. A
   * function and not a shared object, so no caller can edit the default out from under the next one.
   */
  static defaultPlatformSettings(): PlatformSettingsValue {
    return { node: { pnpm: { globalVirtualStore: false } } }
  }

  /**
   * The command a tool runs here: its catalog entry. No setting moves a command, so one worktree's
   * install line stays the same whatever this machine is switched to later.
   */
  static commandOf(toolId: SetupToolId): string {
    const tool = SetupFamilies.catalogConst
      .flatMap((family) => family.tools)
      .find((candidate) => candidate.toolId === toolId)
    if (tool === undefined) throw new Error(`Unknown setup tool: ${JSON.stringify(toolId)}`)
    return tool.command
  }

  /**
   * The variables a tool's install needs with this machine's settings, and that every later process
   * in the same worktree needs as well; empty for a tool no setting touches.
   */
  static variablesOf(toolId: SetupToolId, options: PlatformSettingsValue): Record<string, string> {
    return toolId === 'node-pnpm' && options.node.pnpm.globalVirtualStore
      ? { [SetupFamilies.pnpmGlobalVirtualStoreVariableConst]: 'true' }
      : {}
  }
}
