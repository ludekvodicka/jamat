import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MenuSelection, LaunchConfig, LaunchCommand } from '../../types.js'
import { SESSION_ID_RE } from '../../types.js'
import { buildDockerRunArgs } from '../../executor/docker-utils.js'
import { ensureClaudeProjectTrust } from './trust.js'

const DEFAULT_SCROLL_SPEED = '5'
const DOCKER_IMAGE = 'jamat-isolated'

function buildClaudeFlags(skipPermissions: boolean): string[] {
  return skipPermissions ? ['--dangerously-skip-permissions'] : []
}

function buildEnv(sel: MenuSelection): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
  if (sel.antiFlicker) {
    env['CLAUDE_CODE_NO_FLICKER'] = '1'
    env['CLAUDE_CODE_SCROLL_SPEED'] = DEFAULT_SCROLL_SPEED
  }
  return env
}

function validateSessionId(sel: MenuSelection): void {
  if ((sel.cmd === 'resume' || sel.cmd === 'resume-fork') && sel.sessionId) {
    if (!SESSION_ID_RE.test(sel.sessionId)) throw new Error('Invalid sessionId format')
  }
}

function buildClaudeArgs(sel: MenuSelection, flags: string[]): { args: string[]; fallbackArgs?: string[] } {
  if ((sel.cmd === 'resume' || sel.cmd === 'resume-fork') && sel.sessionId) {
    const forkFlag = sel.cmd === 'resume-fork' ? ['--fork-session'] : []
    const args = ['-r', sel.sessionId, ...forkFlag, ...flags]
    // resume + known fork parent → RE-FORK the parent if the fork's own id is gone (no transcript).
    if (sel.cmd === 'resume' && sel.forkParentId) {
      return { args, fallbackArgs: ['-r', sel.forkParentId, '--fork-session', ...flags] }
    }
    return { args }
  }
  if (sel.cmd === 'ccc') {
    return { args: ['--continue', ...flags], fallbackArgs: [...flags] }
  }
  return { args: [...flags] }
}

function buildShellChain(sel: MenuSelection, flags: string[]): string {
  const flagStr = flags.join(' ')
  if ((sel.cmd === 'resume' || sel.cmd === 'resume-fork') && sel.sessionId) {
    // A resume that knows its fork PARENT: resume the fork's own id, else RE-FORK the parent.
    // A fork that never wrote a turn has no transcript, so plain `claude -r <fork>` fails after a
    // restart — re-forking the same parent recreates it. This is a TARGETED fallback (same
    // parent), NOT the wrong-session `|| --continue` we removed.
    if (sel.cmd === 'resume' && sel.forkParentId) {
      return `claude -r ${sel.sessionId} ${flagStr} || claude -r ${sel.forkParentId} --fork-session ${flagStr}`
    }
    const forkFlag = sel.cmd === 'resume-fork' ? ' --fork-session' : ''
    // NO generic fallback: resuming a SPECIFIC session must fail loudly when its id is gone,
    // rather than silently loading a stranger (the removed `|| --continue` "opened twice" bug).
    return `claude -r ${sel.sessionId}${forkFlag} ${flagStr}`
  }
  if (sel.cmd === 'ccc') return `claude --continue ${flagStr} || claude ${flagStr}`
  return `claude ${flagStr}`
}

function dockerBaseArgs(sel: MenuSelection, volumes: string[], modeFlags: string[]): string[] {
  const flickerEnv = sel.antiFlicker
    ? ['-e', 'CLAUDE_CODE_NO_FLICKER=1', '-e', `CLAUDE_CODE_SCROLL_SPEED=${DEFAULT_SCROLL_SPEED}`]
    : []
  return ['run', ...modeFlags, '-e', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1', ...flickerEnv, ...volumes, DOCKER_IMAGE]
}

// ── Mode × Isolation matrix ──

type Builder = (sel: MenuSelection, flags: string[], dockerContextDir?: string) => LaunchCommand

const terminalNative: Builder = (sel, flags) => {
  const { args, fallbackArgs } = buildClaudeArgs(sel, flags)
  const base: LaunchCommand = { command: 'claude', args, cwd: sel.dir, env: buildEnv(sel) }
  return fallbackArgs ? { ...base, fallback: { ...base, args: fallbackArgs } } : base
}

const terminalDocker: Builder = (sel, flags, dockerContextDir) => {
  const volumes = buildDockerRunArgs(sel.dir, dockerContextDir!)
  const base = dockerBaseArgs(sel, volumes, ['-it', '--rm'])
  const { args, fallbackArgs } = buildClaudeArgs(sel, flags)
  const cmd: LaunchCommand = { command: 'docker', args: [...base, 'claude', ...args], cwd: sel.dir, env: {} }
  return fallbackArgs ? { ...cmd, fallback: { ...cmd, args: [...base, 'claude', ...fallbackArgs] } } : cmd
}

const ptyNative: Builder = (sel, flags) => ({
  command: 'cmd.exe',
  args: ['/c', buildShellChain(sel, flags)],
  cwd: sel.dir,
  env: buildEnv(sel),
})

const ptyDocker: Builder = (sel, flags, dockerContextDir) => {
  const volumes = buildDockerRunArgs(sel.dir, dockerContextDir!)
  const base = dockerBaseArgs(sel, volumes, ['-it', '--rm'])
  const claudeCmd = buildShellChain(sel, flags)
  return {
    command: 'cmd.exe',
    args: ['/c', 'docker', ...base, 'bash', '-c', claudeCmd],
    cwd: sel.dir,
    env: buildEnv(sel),
  }
}

const detachedNative: Builder = (sel, flags) => {
  const allFlags = ['--remote-control', ...flags]
  const { args, fallbackArgs } = buildClaudeArgs(sel, allFlags)
  const base: LaunchCommand = { command: 'claude', args, cwd: sel.dir, env: buildEnv(sel) }
  return fallbackArgs ? { ...base, fallback: { ...base, args: fallbackArgs } } : base
}

const detachedDocker: Builder = (sel, flags, dockerContextDir) => {
  const volumes = buildDockerRunArgs(sel.dir, dockerContextDir!)
  const base = dockerBaseArgs(sel, volumes, ['--rm', '-d'])
  const allFlags = ['--remote-control', ...flags]
  const claudeCmd = buildShellChain(sel, allFlags)
  return {
    command: 'docker',
    args: [...base, 'bash', '-c', claudeCmd],
    cwd: sel.dir,
    env: {},
  }
}

const BUILDERS: Record<string, Builder> = {
  'terminal:native': terminalNative,
  'terminal:docker': terminalDocker,
  'pty:native': ptyNative,
  'pty:docker': ptyDocker,
  'detached:native': detachedNative,
  'detached:docker': detachedDocker,
}

export function buildLaunchCommand(config: LaunchConfig): LaunchCommand {
  const { selection, mode, dockerContextDir, skipPermissions = true } = config
  validateSessionId(selection)
  // Pre-approve the trust + external-CLAUDE.md-import dialogs for the target dir so the
  // launched session starts without blocking on an interactive prompt. Best-effort —
  // a seeding failure must never block a launch. Runs for all three executors (they all
  // funnel through here).
  try { ensureClaudeProjectTrust(selection.dir, join(homedir(), '.claude.json')) } catch { /* best-effort */ }
  const flags = buildClaudeFlags(skipPermissions)
  const isolation = selection.isolated && dockerContextDir ? 'docker' : 'native'
  const key = `${mode}:${isolation}`
  const builder = BUILDERS[key]
  if (!builder) throw new Error(`Unknown launch mode: ${key}`)
  return builder(selection, flags, dockerContextDir)
}
