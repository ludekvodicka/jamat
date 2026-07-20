/**
 * Codex CLI launch-command builder — the analog of `claude/launcher.ts`,
 * mirroring its mode × isolation matrix. Differences from Claude (verified
 * vs codex-cli 0.144.4, see `./README.md`):
 *   - resume is a subcommand: `codex resume <id>` / `codex resume --last`
 *     (not `claude -r <id>`).
 *   - skip-permissions = `--dangerously-bypass-approvals-and-sandbox`.
 *   - no `CLAUDE_CODE_*` env or anti-flicker knobs; `COLORTERM=truecolor`
 *     lets Codex retain its native submitted-message background in Jamat.
 *   - no `--remote-control` (the AI-bridge in `core/jamat` is Claude-only, a
 *     scope non-goal), so `detached` is a plain launch the bridge can't drive.
 *   - session forking maps `resume-fork` → `codex fork <id>` (capabilities.fork=true);
 *     restart-safety comes from the launched-session resolver (resolveCodexLaunchedSession),
 *     which discovers the fork's OWN new id so a restart resumes it, not re-forks the parent.
 *   - Docker isolation lands in U7 (the `dockerized-codex` image); until then a
 *     Codex isolated launch is refused with a clear message, not Claude-in-docker.
 */

import { homedir } from 'os'
import { join } from 'path'
import type { MenuSelection, LaunchConfig, LaunchCommand } from '../../types.js'
import { SESSION_ID_RE } from '../../types.js'
import { shellWrap } from '../../platform-shell.js'
import { ensureCodexProjectTrust } from './trust.js'

function buildFlags(skipPermissions: boolean): string[] {
  return skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : []
}

function buildEnv(): Record<string, string> {
  return { COLORTERM: 'truecolor' }
}

function validateSessionId(sel: MenuSelection): void {
  if ((sel.cmd === 'resume' || sel.cmd === 'resume-fork') && sel.sessionId && !SESSION_ID_RE.test(sel.sessionId))
    throw new Error('Invalid sessionId format')
}

/** Arg vector for the terminal / detached (non-shell) executors. */
function buildArgs(sel: MenuSelection, flags: string[]): { args: string[]; fallbackArgs?: string[] } {
  if (sel.cmd === 'resume') {
    if (!sel.sessionId) throw new Error('codex resume requires a sessionId')
    const args = ['resume', sel.sessionId, ...flags]
    // A resume that knows its fork PARENT re-forks the parent if the fork's own id is gone
    // (mirrors Claude's targeted re-fork fallback — same parent, never a wrong-session load).
    if (sel.forkParentId) return { args, fallbackArgs: ['fork', sel.forkParentId, ...flags] }
    return { args }
  }
  if (sel.cmd === 'resume-fork') {
    if (!sel.sessionId) throw new Error('codex fork requires a sessionId')
    return { args: ['fork', sel.sessionId, ...flags] }
  }
  if (sel.cmd === 'ccc') return { args: ['resume', '--last', ...flags], fallbackArgs: [...flags] }
  if (sel.cmd === 'cc') return { args: [...flags] }
  throw new Error(`Unknown cmd: ${JSON.stringify(sel.cmd)}`)
}

/** Shell chain for the pty executor — carries the `||` fallback, so must run in a shell. */
function buildShellChain(sel: MenuSelection, flags: string[]): string {
  const f = flags.join(' ')
  if (sel.cmd === 'resume') {
    if (!sel.sessionId) throw new Error('codex resume requires a sessionId')
    // A resume carrying a fork parent: resume the fork's own id, else RE-FORK the parent (a fork
    // whose new id is gone after a restart is recreated from the same parent). Otherwise resuming a
    // SPECIFIC session must fail loudly if its id is gone (no wrong-session fallback).
    if (sel.forkParentId) return `codex resume ${sel.sessionId} ${f} || codex fork ${sel.forkParentId} ${f}`.trim()
    return `codex resume ${sel.sessionId} ${f}`.trim()
  }
  if (sel.cmd === 'resume-fork') {
    if (!sel.sessionId) throw new Error('codex fork requires a sessionId')
    return `codex fork ${sel.sessionId} ${f}`.trim()
  }
  if (sel.cmd === 'ccc') return `codex resume --last ${f} || codex ${f}`.trim()
  if (sel.cmd === 'cc') return `codex ${f}`.trim()
  throw new Error(`Unknown cmd: ${JSON.stringify(sel.cmd)}`)
}

type Builder = (sel: MenuSelection, flags: string[]) => LaunchCommand

const terminalNative: Builder = (sel, flags) => {
  const { args, fallbackArgs } = buildArgs(sel, flags)
  const base: LaunchCommand = { command: 'codex', args, cwd: sel.dir, env: buildEnv() }
  return fallbackArgs ? { ...base, fallback: { ...base, args: fallbackArgs } } : base
}

const ptyNative: Builder = (sel, flags) => {
  const wrapped = shellWrap(buildShellChain(sel, flags))
  return { command: wrapped.file, args: wrapped.args, cwd: sel.dir, env: buildEnv() }
}

const detachedNative: Builder = (sel, flags) => {
  // No --remote-control equivalent; a detached Codex tab launches but the bridge can't drive it.
  const { args, fallbackArgs } = buildArgs(sel, flags)
  const base: LaunchCommand = { command: 'codex', args, cwd: sel.dir, env: buildEnv() }
  return fallbackArgs ? { ...base, fallback: { ...base, args: fallbackArgs } } : base
}

const NATIVE_BUILDERS: Record<string, Builder> = {
  terminal: terminalNative,
  pty: ptyNative,
  detached: detachedNative,
}

export function buildCodexLaunchCommand(config: LaunchConfig): LaunchCommand {
  const { selection, mode, dockerContextDir, skipPermissions = true } = config
  validateSessionId(selection)
  // Pre-approve the per-directory "Do you trust this directory?" gate for the target cwd so the
  // launched session starts without blocking on it (the analog of ensureClaudeProjectTrust).
  // Best-effort — a seeding failure must never block a launch.
  try { ensureCodexProjectTrust(selection.dir, join(homedir(), '.codex', 'config.toml')) } catch { /* best-effort */ }
  const isolation = selection.isolated && dockerContextDir ? 'docker' : 'native'
  if (isolation === 'docker')
    throw new Error('Codex Docker isolation is not yet supported — launch the project non-isolated (Codex image lands in a follow-up).')
  const builder = NATIVE_BUILDERS[mode]
  if (!builder) throw new Error(`Unknown launch mode: ${mode}`)
  return builder(selection, buildFlags(skipPermissions))
}
