/**
 * Per-agent PRE-LAUNCH hooks — a config-driven command run in a project dir right before an agent
 * instance is created there. The motivating case is the Codex AGENTS.md packer: flattening our
 * CLAUDE.md cascade into a Codex-native `<dir>/AGENTS.md` before the `codex` process starts, so a
 * Codex session sees our conventions.
 *
 * It is deliberately OPT-IN and CONFIG-DRIVEN (`AppConfig.agents.<id>.preLaunch`): the committed
 * public config ships without it, so a clone runs Codex unchanged; our SVN-only private config sets
 * the packer. Nothing is hardcoded, so publishing the app forces the packer on nobody.
 *
 * It is also NON-FATAL by contract: `runAgentPreLaunch` NEVER throws. A non-zero exit, a spawn
 * error (e.g. the packer hard-failing outside an `Applications*` tree), or a timeout returns
 * `{status:'failed'}` — the caller logs it and launches the agent anyway.
 *
 * core/ rule compliance: no UI/framework deps; the caller passes the resolved hook (from its already
 * loaded `AppConfig`) rather than this module reading global config.
 */
import { spawnSync as realSpawnSync } from 'child_process'
import { homedir } from 'os'
import { shellWrapArgv } from '../platform-shell.js'
import type { AgentId, AgentPreLaunch, MenuSelection } from '../types/contracts.js'
import type { AgentsConfig } from '../types/config.js'

const DEFAULT_TIMEOUT_MS = 20_000

export type PreLaunchStatus = 'ok' | 'skipped' | 'failed'
export interface PreLaunchResult {
  status: PreLaunchStatus
  /** A one-line reason on `failed` (last stderr/stdout line, exit code, or error message). */
  detail?: string
}

/** The pre-launch hook configured for `agent`, or undefined when none/absent. */
export function resolveAgentPreLaunch(agents: AgentsConfig | undefined, agent: AgentId | undefined): AgentPreLaunch | undefined {
  if (!agents || !agent) return undefined
  return agents[agent]?.preLaunch
}

/** Expand a leading `~` / `~/…` / `~\…` to the home dir; a `~` anywhere else is left as-is. */
function expandHome(token: string, home: string): string {
  if (token === '~') return home
  if (token.startsWith('~/') || token.startsWith('~\\')) return home + token.slice(1)
  return token
}

/** Substitute `{dir}` (absolute project path) and `{name}` (folder name), same as CustomRun. */
function substitute(token: string, sel: MenuSelection): string {
  return token.replace(/\{dir\}/g, sel.dir).replace(/\{name\}/g, sel.folderName)
}

interface RunDeps {
  /** Injectable for tests (capture the resolved argv without spawning). Defaults to the real one. */
  spawnSync?: typeof realSpawnSync
  /** Injectable home dir for deterministic `~` expansion in tests. */
  homeDir?: string
}

/**
 * Run an agent's pre-launch hook before the caller spawns the agent. Returns `skipped` when no hook
 * is configured, `ok` on a clean (exit-0) run, `failed` otherwise. NEVER throws.
 *
 * `command`/`args`/`cwd` get `~` expansion + `{dir}`/`{name}` substitution; the spawn is routed
 * through `shellWrapArgv` so PATH shims (`node`, a `.cmd`/`.bat` wrapper) resolve exactly like every
 * other Jamat spawn. A missing `cwd` defaults to the project dir being launched.
 */
export function runAgentPreLaunch(hook: AgentPreLaunch | undefined, sel: MenuSelection, deps: RunDeps = {}): PreLaunchResult {
  if (!hook || !hook.command || !hook.command.trim()) return { status: 'skipped' }
  const spawnSync = deps.spawnSync ?? realSpawnSync
  const home = deps.homeDir ?? homedir()
  const command = expandHome(hook.command, home)
  const args = (hook.args ?? []).map((a) => expandHome(substitute(a, sel), home))
  const cwd = hook.cwd ? expandHome(substitute(hook.cwd, sel), home) : sel.dir
  const timeout = hook.timeoutMs && hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_TIMEOUT_MS
  try {
    const wrapped = shellWrapArgv(command, args)
    const r = spawnSync(wrapped.file, wrapped.args, { cwd, timeout, windowsHide: true, encoding: 'utf-8' })
    if (r.error) return { status: 'failed', detail: r.error.message }
    if (typeof r.status === 'number' && r.status !== 0) {
      const out = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim()
      const lastLine = out.split(/\r?\n/).filter(Boolean).pop()
      return { status: 'failed', detail: lastLine || `exit ${r.status}` }
    }
    if (r.status === null) {
      // Killed by signal or the timeout — no exit code. Non-fatal, like every other failure.
      return { status: 'failed', detail: r.signal ? `killed (${r.signal})` : 'no exit status' }
    }
    return { status: 'ok' }
  } catch (e) {
    return { status: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}
