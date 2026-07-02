/**
 * "Claude abilities" — the discoverable things Claude Code can do on a machine
 * (skills, slash commands, plugins, agents, MCP servers). Surfaced by the
 * Claude Abilities tab. Pure data; scanned from `~/.claude` by `core/abilities/scan.ts`.
 */

export type AbilityKind = 'skill' | 'command' | 'plugin' | 'agent' | 'mcp' | 'instruction'

/** A plugin's bundled abilities, nested under the plugin row (not surfaced top-level). */
export interface AbilityChildren {
  skills: Ability[]
  commands: Ability[]
  agents: Ability[]
}

/** A project a plugin is scoped/enabled in (from installed_plugins.json records). */
export interface PluginScopeRef {
  /** project = committed (.claude/settings.json); local = local-only (.claude/settings.local.json). */
  kind: 'project' | 'local'
  /** Absolute project path the plugin is scoped to. */
  project: string
}

/** Where a plugin is enabled: globally (user settings.json `enabledPlugins`) and/or per-project. */
export interface PluginScope {
  /** Enabled globally via ~/.claude/settings.json `enabledPlugins`. */
  global: boolean
  /** Per-project scoped installs (non-`user` records). */
  refs: PluginScopeRef[]
}

export interface Ability {
  kind: AbilityKind
  /** Invokable/display name (frontmatter `name`, else filename / config key). */
  name: string
  /** One-line description when available (frontmatter `description`, command first line, MCP command). */
  description?: string
  /** Where it comes from: `user` (~/.claude) or `plugin:<pluginName>`. */
  source: string
  /** Absolute path to the defining file/dir, for reference. */
  path?: string
  /** Plugins only: installed version. */
  version?: string
  /** Plugins only: the skills/commands/agents this plugin bundles (shown when the row is expanded). */
  children?: AbilityChildren
  /** Plugins only: where the plugin is enabled (global vs per-project). */
  scope?: PluginScope
  /** For file/dir-backed abilities (skills/commands/agents): is the entry a symlink/junction
   *  or a direct local file? Lets the UI tag synced (symlinked) abilities vs. local ones. */
  link?: 'symlink' | 'local'
  /** When `link === 'symlink'`: where the symlink/junction points (its resolved target). */
  linkTarget?: string
  /** Plugins only: the installed_plugins.json key (`name@marketplace`) — needed to toggle/remove it. */
  pluginKey?: string
}

/** Mutating actions for the `abilities:manage` op (enable/disable; remove added in a later unit). */
export type AbilitiesManageAction =
  | 'enablePlugin' | 'disablePlugin'
  | 'enableSkill' | 'disableSkill'
  | 'removePlugin' | 'removeSkill'

export interface AbilitiesManageRequest {
  action: AbilitiesManageAction
  /** *Plugin actions: the installed_plugins.json key (`name@marketplace`).
   *  *Skill actions: the skill dir name under ~/.claude/skills. */
  name: string
}

export interface AbilitiesManageResult {
  ok: boolean
  error?: string
}

export interface AbilitiesResult {
  skills: Ability[]
  commands: Ability[]
  plugins: Ability[]
  agents: Ability[]
  mcp: Ability[]
  /** Custom CLAUDE.md-style instruction files (~/.claude/CLAUDE.md + extensions/instructions/*.md).
   *  `scope.global` = reachable from the root CLAUDE.md @-import graph (auto-loaded everywhere). */
  instructions: Ability[]
  /** Non-fatal warnings (a source that couldn't be read). */
  warnings: string[]
  /** The home dir that was scanned. */
  homeDir: string
}
