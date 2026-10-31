/**
 * What this member knows about a project root: which family it belongs to, and what installs its
 * dependencies. Everything here is data - no `node:` import, no runtime code - after
 * `git/git.types.ts`, so session records and wire types can name these shapes freely.
 */

export type SetupFamilyId = 'node' | 'python' | 'rust' | 'go'
export type SetupScope = 'project' | 'members'

/**
 * How THIS machine installs, per family: the middle of the three tiers, under everything a project
 * declares for itself and over every family default. Total by the time anybody reads it - the client
 * coerces it out of `config.json` - so nothing downstream asks whether a key is there.
 */
export interface PlatformSettingsValue {
  node: { pnpm: { globalVirtualStore: boolean } }
}

export type SetupToolId =
  | 'node-pnpm' | 'node-npm' | 'node-yarn'
  | 'python-uv' | 'python-poetry'
  | 'rust-cargo'
  | 'go-mod'

/**
 * A detector says WHAT a project is and never which command to run: which command installs
 * `node-pnpm` on this machine is a setting, and settings belong to the manager. A detector that
 * returned a command string would make the two indistinguishable.
 */
export interface SetupDetector {
  readonly familyId: SetupFamilyId
  /** Null when this family is not here at all - not an opinion, an absence. */
  detect(projectRoot: string, repositoryRoot: string): Promise<SetupDetection | null>
}

export type SetupDetection =
  /** `installCwd` is repository-relative; without it the project's own location is where it runs. */
  | { kind: 'tool'; toolId: SetupToolId; installCwd?: string }
  | { kind: 'ambiguous'; reason: string }

/**
 * One step of a setup. `cwd` is relative to the repository root and `''` is the root itself, because
 * the step is resolved in the main copy and run in a worktree - only a relative path survives that
 * move. It is forward-slashed in both spellings: `node:path` joins either separator on win32, and one
 * spelling keeps a stored step comparable to the one that produced it.
 */
export interface SetupStep {
  command: string
  cwd: string
}

/**
 * Who wrote the steps, which is the same question as how far they are trusted. `project` means the
 * repository's own `.worktree.json` - a file that arrives with a clone, from whoever authored it -
 * and it is the only origin this machine did not choose. `machine` covers both other tiers: a command
 * from this machine's settings and a family's built-in default are equally ours.
 */
export type SetupOrigin = 'project' | 'machine'

export type SetupResolution =
  /**
   * `variables`: what the steps run with, and what every later process in the worktree has to carry
   * so it sees the same dependency layout. Always empty for `project`: a `.worktree.json` command
   * runs as written, and this machine's settings apply only to the commands it chose itself.
   */
  | { kind: 'setup'; origin: SetupOrigin; steps: SetupStep[]; variables: Record<string, string> }
  /** An explicit `"setup": []`: the project needs nothing, and says so in a file that travels with it. */
  | { kind: 'empty' }
  | { kind: 'none'; reason: string }
