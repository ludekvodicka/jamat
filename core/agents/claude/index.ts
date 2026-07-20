/**
 * ClaudeAdapter — concrete implementation of `AgentAdapter` for Claude
 * Code. All Claude-specific paths, JSONL parsing, CLI invocation, TUI
 * patterns, and slash commands live under `core/agents/claude/` and
 * are exposed through this class.
 *
 * Internal module layout:
 * - `sessions.ts`        — ~/.claude/projects/ paths, JSONL header parsing,
 *                          loadSessionsForProject, appendCustomTitleLine
 * - `session-changes.ts` — JSONL tool_use parser (turns, edited files)
 * - `launcher.ts`        — CLI build (resume / continue / docker)
 * - `patterns.ts`        — TUI regex constants + EDITED_FILE_TOOLS set
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import {
  pathToProjectDirName,
  findProjectDir as findClaudeProjectDir,
  loadSessionsForProject,
  buildSessionMetaCache as buildClaudeSessionMetaCache,
  loadSessionPreview as loadClaudeSessionPreview,
  invalidateProjectDirCache,
  appendCustomTitleLine,
  findCustomTitle,
  listActiveSessionPids,
  extractSessionEditedFiles,
  resolveActiveSessionFile as resolveClaudeActiveSessionFile,
  readSessionModelInfo as readClaudeSessionModelInfo,
  readEffortLevel as readClaudeEffortLevel,
  claudeConfigHome,
} from './sessions.js'
import {
  extractSessionTurns,
  extractSessionHasEdits,
} from './session-changes.js'
import { buildLaunchCommand as buildClaudeLaunchCommand } from './launcher.js'
import { CLAUDE_CAPABILITIES, claudeRenameSlash } from './renderer-meta.js'
import { AgentAdapterBase } from '../base.js'
import type {
  AgentSession,
  AgentTurnInfo,
  ExecCommand,
  ExecOptions,
  SessionTitleWatchTarget,
} from '../types.js'
import type { LaunchCommand, LaunchMode, MenuSelection } from '../../types/contracts.js'
import type { SessionModelInfo, LatestSessionMeta } from '../../types/session.js'

export class ClaudeAdapter extends AgentAdapterBase {
  readonly id = 'claude' as const
  readonly displayName = 'Claude'
  readonly binary = 'claude'
  readonly capabilities = CLAUDE_CAPABILITIES

  // --- 1. Filesystem ---

  sessionsRoot(homeDir: string): string {
    return join(claudeConfigHome(homeDir), 'projects')
  }

  encodeProjectDir(projectDir: string): string {
    return pathToProjectDirName(projectDir)
  }

  // --- 2. Discovery ---

  listProjects(homeDir: string): string[] {
    const root = this.sessionsRoot(homeDir)
    try {
      return readdirSync(root)
        .filter((d) => {
          try { return statSync(join(root, d)).isDirectory() } catch { return false }
        })
        .map((d) => join(root, d))
    } catch {
      return []
    }
  }

  // `findProjectDir` (real cwd → encoded storage dir) resolves homeDir
  // internally; the param documents the interface contract.
  findProjectDir(projectDir: string, _homeDir: string): string | null {
    return findClaudeProjectDir(projectDir)
  }

  listSessionsForProject(projectDir: string, _homeDir: string): AgentSession[] {
    // `loadSessionsForProject` accepts the ENCODED path (the on-disk
    // folder under ~/.claude/projects/<encoded>/), not the real cwd.
    return loadSessionsForProject(projectDir)
  }

  buildSessionMetaCache(catPath: string, folderNames: string[]): Map<string, LatestSessionMeta> {
    return buildClaudeSessionMetaCache(catPath, folderNames)
  }

  loadSessionPreview(projectDir: string, sessionId: string): string[] {
    return loadClaudeSessionPreview(projectDir, sessionId)
  }

  invalidateDiscoveryCache(): void {
    invalidateProjectDirCache()
  }

  resolveSessionFile(projectDir: string, sessionId: string, _homeDir: string): string | null {
    const p = join(projectDir, `${sessionId}.jsonl`)
    return existsSync(p) ? p : null
  }

  resolveActiveSessionFile(projectDir: string, sessionId: string | null, _homeDir: string): string | null {
    return resolveClaudeActiveSessionFile(projectDir, sessionId)
  }

  findSessionFileById(sessionId: string, homeDir: string): string | null {
    const root = this.sessionsRoot(homeDir)
    try {
      for (const projDir of readdirSync(root)) {
        const p = join(root, projDir, `${sessionId}.jsonl`)
        if (existsSync(p)) return p
      }
    } catch { /* no sessions root */ }
    return null
  }

  // --- 3. JSONL parsing ---

  extractTurns(sessionFile: string): AgentTurnInfo[] {
    return extractSessionTurns(sessionFile)
  }

  hasFileEdits(sessionFile: string): boolean {
    return extractSessionHasEdits(sessionFile)
  }

  extractEditedFiles(sessionFile: string): string[] {
    return extractSessionEditedFiles(sessionFile)
  }

  appendCustomTitle(sessionFile: string, sessionId: string, title: string): boolean {
    return appendCustomTitleLine(sessionFile, sessionId, title)
  }

  getSessionTitle(sessionFile: string): string | null {
    return findCustomTitle(sessionFile)
  }

  getSessionTitleWatchTarget(projectDir: string, sessionId: string, _homeDir: string): SessionTitleWatchTarget {
    return { dir: projectDir, base: `${sessionId}.jsonl` }
  }

  listActivePids(_homeDir: string): { pid: number; sessionId: string }[] {
    // `listActiveSessionPids` reads ~/.claude/sessions via homedir() itself;
    // the param documents the interface contract.
    return listActiveSessionPids()
  }

  readSessionModelInfo(sessionFile: string, projectDir: string, homeDir: string): SessionModelInfo | null {
    const info = readClaudeSessionModelInfo(sessionFile)
    return info ? { ...info, effortLevel: readClaudeEffortLevel(projectDir, homeDir) } : null
  }

  // --- 4. CLI invocation ---

  buildLaunchCommand(sel: MenuSelection, mode: LaunchMode, opts?: { dockerContextDir?: string; skipPermissions?: boolean }): LaunchCommand {
    return buildClaudeLaunchCommand({
      selection: sel,
      mode,
      dockerContextDir: opts?.dockerContextDir,
      skipPermissions: opts?.skipPermissions,
    })
  }

  buildExecCommand(prompt: string, model: string, opts?: ExecOptions): ExecCommand {
    // Stdin carries the caller's payload (typically a git diff) piped in
    // by the child_process.spawn caller.
    const args: string[] = ['-p', '--model', model]
    if (opts?.permissionMode === 'plan') args.push('--permission-mode', 'plan')
    if (opts?.allowedTools) args.push('--allowedTools', opts.allowedTools.join(','))
    if (opts?.ephemeral) args.push('--no-session-persistence')
    return { command: 'claude', args, stdin: prompt }
  }

  // --- 6. Slash commands ---

  renameSlashCommand(name: string): string {
    return claudeRenameSlash(name)
  }

  // --- 7. Permissions ---

  permissionConfigPaths(projectDir: string, homeDir: string): string[] {
    return [
      join(projectDir, '.claude', 'settings.local.json'),
      join(projectDir, '.claude', 'settings.json'),
      join(claudeConfigHome(homeDir), 'settings.json'),
    ]
  }
}
