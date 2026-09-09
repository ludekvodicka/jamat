/**
 * Where the AI's own versioning lives and what it is called: the checkpoint store.
 *
 * **Deliberately web-safe and import-free**, the same bargain `worktreeNaming.ts` makes: a value
 * class of fixed strings that both sides of a boundary must agree on. Here the boundary is not the
 * renderer but another language entirely - `Q:\Tooling\agent_extensions\runtime-scripts\commit-git.sh`
 * implements this same layout in bash, because a plain Claude session in a terminal has to be able
 * to checkpoint without AppJamatV3 running, and AppJamatV3 has to work without a shell.
 *
 * Neither side can import the other, so the duplication is deliberate and the only thing keeping the
 * two from drifting is one written description, in
 * `Q:\Tooling\agent_extensions\instructions\versioning-full.md`, section
 * "Checkpoint store - layout kontrakt". Change that table first, then both implementations.
 *
 * The store is a BARE repository inside the project whose work-tree is the project root. It has no
 * remote and is never pushed: that is what makes it safe to keep AI history in a project whose own
 * `.git` belongs to a human, and what makes a project with no `.git` at all a perfectly normal
 * state rather than something to fix with `git init`.
 */
export class CheckpointLayout {
  static readonly folderNameConst = '.checkpoints'
  static readonly storeNameConst = 'store.git'
  static readonly storeRelativeConst = '.checkpoints/store.git'

  /** The main copy's checkpoint line. Worktrees keep `WorktreeNaming`'s `jamat/<slug>`. */
  static readonly branchConst = 'main'

  /**
   * Checkpoint commits AppJamatV3 makes itself carry this, passed as `-c` arguments: `GitInvoker`
   * strips inherited `GIT_*` from the child environment on purpose, so an environment identity
   * cannot reach them. In the store it should be visible that a tool wrote this, not a person.
   */
  static readonly authorNameConst = 'jamat'
  static readonly authorEmailConst = 'jamat@jamat-v3.local'

  /**
   * What a store ignores no matter what. Without the first line it would stage its own object
   * database on every checkpoint; the mirror of the global gitignore is added at init on top of
   * these, because a bare repository reads no `core.excludesFile` of its own.
   */
  static readonly selfExcludesConst: readonly string[] = ['/.checkpoints/', '/.worktrees/', '/.svn/']

  /** What a human `.git` beside the store must ignore, so neither shows up in the human's status. */
  static readonly humanExcludesConst: readonly string[] = ['/.checkpoints/', '/.worktrees/']
}
