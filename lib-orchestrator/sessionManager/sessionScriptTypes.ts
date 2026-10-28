/**
 * One step of a scripted shell. Unlike the `SetupStep` a resolution is made of, `cwd` here is
 * absolute and already inside the worktree: the record is what a launch is planned from, and a launch
 * has no repository root to resolve a relative step against.
 */
export interface SessionRecordSetupCommand {
  command: string
  cwd: string
}

/**
 * A run that spawns an executable directly, with no shell between: `tool` is resolved on this machine
 * at every launch (`RunTools`), and each argument reaches the process as one argv element, byte for byte.
 */
export interface SessionRecordProcess {
  tool: 'svn' | 'jamat-cli'
  /** Only what `SvnWorktreeEvidence.takesArgument` admits; `ScriptRunRecords.processRun` enforces it. */
  args: string[]
}

/** One step of a chain, resolved when the chain starts. `key` is its identity for resume and evidence. */
export interface SessionRecordScriptStep {
  /** `ScriptChain.keyOf({ scriptId, name, commands, process })`. */
  key: string
  /**
   * `checks`: a `scripts.after` entry frozen on an SVN action; `declared` serves the before chain and
   * Git's Finish checks; `svn`: the checkout that leads the before chain of an SVN worktree.
   */
  scriptId: 'setup' | 'declared' | 'checks' | 'svn'
  /** 'setup', 'checkout', or the `.worktree.json` entry name. */
  name: string
  /** Absolute directories inside the worktree; empty for a process step. */
  commands: SessionRecordSetupCommand[]
  /** A direct-process step and the absolute directory it runs in. */
  process?: SessionRecordProcess & { cwd: string }
}
