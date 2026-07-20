/**
 * `AgentAdapterBase` — the universal agent both `ClaudeAdapter` and
 * `CodexAdapter` extend. It carries two things every backend shares:
 *
 * 1. **Graceful-degrade defaults** for the members an agent may legitimately
 *    lack (rename persistence, live pids, session runtime info, exec-output parsing…).
 *    A backend overrides only what it really has; Codex leans on the defaults.
 * 2. **Shared protected helpers** — a tolerant JSONL iterator, a
 *    newline-guarded append, and safe fs probes — so the transcript-scanning
 *    logic (and the learning-#002 append guard) lives in exactly one place.
 *
 * Discovery + spawn members stay `abstract` — every agent MUST implement them;
 * there is no sensible default for "where do sessions live" or "how to launch".
 *
 * `AgentAdapter` stays the consumer-facing type — nothing imports the base
 * except the two adapters. Pure Node fs, no electron / node-pty (same rule as
 * the rest of `core/`).
 */

import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs'
import type { AgentId } from '../types/contracts.js'
import type { LaunchCommand, LaunchMode, MenuSelection } from '../types/contracts.js'
import type { SessionModelInfo, LatestSessionMeta } from '../types/session.js'
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentSession,
  AgentTurnInfo,
  ExecCommand,
  ExecOptions,
  SessionTitleWatchTarget,
} from './types.js'

export abstract class AgentAdapterBase implements AgentAdapter {
  // --- Identity + capabilities (agent-specific) ---
  abstract readonly id: AgentId
  abstract readonly displayName: string
  abstract readonly binary: string
  abstract readonly capabilities: AgentCapabilities
  // --- Discovery + spawn: no sensible default, every agent implements ---
  abstract sessionsRoot(homeDir: string): string
  abstract listProjects(homeDir: string): string[]
  abstract findProjectDir(projectDir: string, homeDir: string): string | null
  abstract listSessionsForProject(projectDir: string, homeDir: string): AgentSession[]
  abstract buildSessionMetaCache(catPath: string, folderNames: string[]): Map<string, LatestSessionMeta>
  abstract resolveSessionFile(projectDir: string, sessionId: string, homeDir: string): string | null
  abstract resolveActiveSessionFile(projectDir: string, sessionId: string | null, homeDir: string): string | null
  abstract findSessionFileById(sessionId: string, homeDir: string): string | null
  abstract extractTurns(sessionFile: string): AgentTurnInfo[]
  abstract hasFileEdits(sessionFile: string): boolean
  abstract extractEditedFiles(sessionFile: string): string[]
  abstract buildLaunchCommand(
    sel: MenuSelection,
    mode: LaunchMode,
    opts?: { dockerContextDir?: string; skipPermissions?: boolean },
  ): LaunchCommand
  abstract buildExecCommand(prompt: string, model: string, opts?: ExecOptions): ExecCommand
  abstract permissionConfigPaths(projectDir: string, homeDir: string): string[]

  // --- Graceful-degrade defaults (override only what the agent really has) ---

  encodeProjectDir(_projectDir: string): string { return '' }
  loadSessionPreview(_projectDir: string, _sessionId: string): string[] { return [] }
  invalidateDiscoveryCache(): void { /* no discovery cache by default */ }
  appendCustomTitle(_sessionFile: string, _sessionId: string, _title: string): boolean { return false }
  getSessionTitle(_sessionFile: string): string | null { return null }
  getSessionTitleWatchTarget(_projectDir: string, _sessionId: string, _homeDir: string): SessionTitleWatchTarget | null { return null }
  listActivePids(_homeDir: string): { pid: number; sessionId: string }[] { return [] }
  /** Pid-tracking agents resolve via listActivePids; no-pid agents (Codex) override this. */
  resolveLaunchedSession(_projectDir: string, _homeDir: string, _sinceMs: number): { sessionId: string } | null { return null }
  readSessionModelInfo(_sessionFile: string, _projectDir: string, _homeDir: string): SessionModelInfo | null { return null }
  renameSlashCommand(_name: string): string | null { return null }
  /** Plain-text exec (e.g. `claude -p`) needs no parsing; NDJSON backends override. */
  parseExecOutput(raw: string): string { return raw.trim() }

  // --- Shared protected helpers ---

  protected safeReaddir(dir: string): string[] {
    try { return readdirSync(dir) } catch { return [] }
  }

  protected safeMtimeMs(path: string): number | null {
    try { return statSync(path).mtimeMs } catch { return null }
  }

  /**
   * Iterate a JSONL file record-by-record, SKIPPING any line that doesn't parse
   * (a truncated tail, a partial mid-write) instead of throwing — a Codex
   * rollout with three schema generations must not brick on one bad line.
   */
  protected *iterateJsonlRecords(file: string): Generator<unknown> {
    let text: string
    try { text = readFileSync(file, 'utf-8') } catch { return }
    for (const line of text.split('\n')) {
      if (!line) continue
      try { yield JSON.parse(line) } catch { /* skip unparseable line */ }
    }
  }

  /**
   * Append one JSON record as a line, guarding the JSONL one-record-per-line
   * contract (learning #002): if a prior write left the file WITHOUT a trailing
   * newline, our record would fuse onto the previous one and corrupt that
   * segment for every future parse. Prepend a newline when the last byte isn't
   * `\n`. Returns false on a missing file or any fs error.
   */
  protected appendJsonlLine(file: string, record: object): boolean {
    if (!existsSync(file)) return false
    let line = JSON.stringify(record) + '\n'
    try {
      const size = statSync(file).size
      if (size > 0) {
        const fd = openSync(file, 'r')
        try {
          const last = Buffer.alloc(1)
          readSync(fd, last, 0, 1, size - 1)
          if (last[0] !== 0x0a) line = '\n' + line
        } finally {
          closeSync(fd)
        }
      }
      appendFileSync(file, line, 'utf-8')
      return true
    } catch {
      return false
    }
  }
}
