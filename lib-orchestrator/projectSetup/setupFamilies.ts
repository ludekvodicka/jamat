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
  /** The pnpm option this machine can turn on; named apart because it is the one command a setting moves. */
  static readonly pnpmGlobalVirtualStoreCommandConst =
    'pnpm install --config.enableGlobalVirtualStore=true'

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
   * The command a tool runs here. Every tool takes its catalog entry; pnpm is the one whose entry is
   * replaced by this machine's own answer, which is what the settings tier exists for.
   */
  static commandOf(toolId: SetupToolId, options: PlatformSettingsValue): string {
    if (toolId === 'node-pnpm' && options.node.pnpm.globalVirtualStore)
      return SetupFamilies.pnpmGlobalVirtualStoreCommandConst
    const tool = SetupFamilies.catalogConst
      .flatMap((family) => family.tools)
      .find((candidate) => candidate.toolId === toolId)
    if (tool === undefined) throw new Error(`Unknown setup tool: ${JSON.stringify(toolId)}`)
    return tool.command
  }
}
