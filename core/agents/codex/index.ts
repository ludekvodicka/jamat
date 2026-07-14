/**
 * CodexAdapter — extends `AgentAdapterBase`. Discovery + JSONL parsing (U3,
 * backed by `sessions.ts` / `session-changes.ts` against the U2 fixtures) and
 * CLI launch/resume/exec (U4, `launcher.ts`) are real. `parseExecOutput` is
 * overridden for Codex's NDJSON exec stream; Docker isolation still refuses
 * loudly until U7 builds the `dockerized-codex` image. Every remaining
 * "doesn't apply" member (encodeProjectDir, appendCustomTitle, listActivePids,
 * readSessionModelInfo, readEffortLevel, renameSlashCommand) is inherited from the base.
 *
 * Codex keys sessions by DATE + a `cwd` header, not by project dir — see
 * `sessions.ts` and `./README.md` (schema verified vs codex-cli 0.144.1).
 */

import { join } from 'path'
import { CODEX_TTY_PATTERNS, CODEX_CAPABILITIES } from './renderer-meta.js'
import { AgentAdapterBase } from '../base.js'
import {
  findCodexProjectDir,
  listCodexSessionsForProject,
  buildCodexSessionMetaCache,
  findCodexSessionFileById,
  resolveCodexActiveSessionFile,
  resolveCodexLaunchedSession,
  loadCodexSessionPreview,
  invalidateCodexIndex,
} from './sessions.js'
import { extractCodexTurns, extractCodexHasEdits, extractCodexEditedFiles } from './session-changes.js'
import { buildCodexLaunchCommand } from './launcher.js'
import type {
  AgentSession,
  AgentTurnInfo,
  AgentTtyPatterns,
  ExecCommand,
  ExecOptions,
} from '../types.js'
import type { LaunchCommand, LaunchMode, MenuSelection } from '../../types/contracts.js'
import type { LatestSessionMeta } from '../../types/session.js'

export class CodexAdapter extends AgentAdapterBase {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'
  readonly binary = 'codex'
  readonly capabilities = CODEX_CAPABILITIES
  readonly ttyPatterns: AgentTtyPatterns = CODEX_TTY_PATTERNS

  // --- 1. Filesystem (join, not POSIX concat → Windows-safe, learning #029) ---
  sessionsRoot(homeDir: string): string {
    return join(homeDir, '.codex', 'sessions')
  }

  // --- 2. Discovery — date-tree walker + cwd index (U3) ---
  // `listProjects` (all cwds Codex has sessions for) has no menu consumer yet — [].
  listProjects(_homeDir: string): string[] { return [] }
  findProjectDir(projectDir: string, homeDir: string): string | null {
    return findCodexProjectDir(projectDir, homeDir)
  }
  listSessionsForProject(projectDir: string, homeDir: string): AgentSession[] {
    return listCodexSessionsForProject(projectDir, homeDir)
  }
  buildSessionMetaCache(catPath: string, folderNames: string[]): Map<string, LatestSessionMeta> {
    return buildCodexSessionMetaCache(catPath, folderNames)
  }
  loadSessionPreview(projectDir: string, sessionId: string): string[] {
    return loadCodexSessionPreview(projectDir, sessionId)
  }
  invalidateDiscoveryCache(): void {
    invalidateCodexIndex()
  }
  // Codex sessions live by date, not under projectDir — id lookup ignores projectDir.
  resolveSessionFile(_projectDir: string, sessionId: string, homeDir: string): string | null {
    return findCodexSessionFileById(sessionId, homeDir)
  }
  resolveActiveSessionFile(projectDir: string, sessionId: string | null, homeDir: string): string | null {
    return resolveCodexActiveSessionFile(projectDir, sessionId, homeDir)
  }
  findSessionFileById(sessionId: string, homeDir: string): string | null {
    return findCodexSessionFileById(sessionId, homeDir)
  }
  // Codex has no live pids — a just-launched tab (new session or fork) resolves its id by
  // finding the newest rollout for the cwd created at/after launch (see the base contract).
  resolveLaunchedSession(projectDir: string, homeDir: string, sinceMs: number): { sessionId: string } | null {
    return resolveCodexLaunchedSession(projectDir, homeDir, sinceMs)
  }

  // --- 3. JSONL parsing (U3) ---
  extractTurns(sessionFile: string): AgentTurnInfo[] {
    return extractCodexTurns(sessionFile)
  }
  hasFileEdits(sessionFile: string): boolean {
    return extractCodexHasEdits(sessionFile)
  }
  extractEditedFiles(sessionFile: string): string[] {
    return extractCodexEditedFiles(sessionFile)
  }

  // --- 4. CLI invocation (U4) ---
  buildLaunchCommand(sel: MenuSelection, mode: LaunchMode, opts?: { dockerContextDir?: string; skipPermissions?: boolean }): LaunchCommand {
    return buildCodexLaunchCommand({
      selection: sel,
      mode,
      dockerContextDir: opts?.dockerContextDir,
      skipPermissions: opts?.skipPermissions,
    })
  }

  buildExecCommand(prompt: string, model: string, opts?: ExecOptions): ExecCommand {
    const args = ['exec', '--json', '--skip-git-repo-check']
    if (model) args.push('--model', model)
    if (opts?.ephemeral) args.push('--ephemeral')
    if (opts?.permissionMode === 'plan') args.push('--sandbox', 'read-only')
    args.push(prompt)
    // Codex appends piped stdin as a `<stdin>` block when a prompt arg is present (verified via --help),
    // so the AI-commit diff rides on stdin while the instructions stay in the prompt arg.
    return { command: 'codex', args, stdin: opts?.stdinPayload ?? '' }
  }

  /** `codex exec --json` streams NDJSON; the final answer is the last `agent_message` item. */
  parseExecOutput(raw: string): string {
    let last = ''
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } }
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string')
          last = ev.item.text
      } catch { /* non-JSON noise line */ }
    }
    return last.trim()
  }

  // --- 7. Permissions — Codex config.toml (project override then user-global) ---
  permissionConfigPaths(projectDir: string, homeDir: string): string[] {
    return [
      join(projectDir, '.codex', 'config.toml'),
      join(homeDir, '.codex', 'config.toml'),
    ]
  }
}
