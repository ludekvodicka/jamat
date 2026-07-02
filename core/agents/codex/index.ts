/**
 * CodexAdapter stub.
 *
 * Open verification items before this can be real:
 * `docs/architecture/codex-portability-assessment.md` §"Open
 * verification items" and `./README.md`.
 *
 * Methods that participate in the spawn path THROW with a clear
 * message so user-facing errors surface as "codex backend not yet
 * implemented" rather than silent failures. Methods that are
 * legitimately "doesn't apply" (e.g. `appendCustomTitle` on an agent
 * whose parser rejects unknown records) return a graceful no-op
 * value (false / null / []).
 */

import { join } from 'path'
import { CODEX_TTY_PATTERNS, codexRenameSlash } from './renderer-meta.js'
import type {
  AgentAdapter,
  AgentSession,
  AgentTurnInfo,
  AgentTtyPatterns,
  ExecCommand,
  ExecOptions,
} from '../types.js'
import type { LaunchCommand, LaunchMode, MenuSelection } from '../../types/contracts.js'
import type { SessionModelInfo, LatestSessionMeta } from '../../types/session.js'

const NOT_IMPLEMENTED = (): Error =>
  new Error('codex backend not yet implemented — see docs/architecture/codex-portability-assessment.md')

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'
  readonly binary = 'codex'

  // 1. Filesystem — known shape; doesn't need spawn so doesn't throw
  sessionsRoot(homeDir: string): string {
    return join(homeDir, '.codex', 'sessions')
  }
  encodeProjectDir(_projectDir: string): string {
    // Codex doesn't encode by project — sessions live under YYYY/MM/DD/.
    return ''
  }

  // 2. Discovery — would walk the date tree; not implemented
  listProjects(_homeDir: string): string[] { return [] }
  findProjectDir(_projectDir: string, _homeDir: string): string | null { return null }
  listSessionsForProject(_projectDir: string, _homeDir: string): AgentSession[] { return [] }
  buildSessionMetaCache(_catPath: string, _folderNames: string[]): Map<string, LatestSessionMeta> { return new Map() }
  loadSessionPreview(_projectDir: string, _sessionId: string): string[] { return [] }
  invalidateDiscoveryCache(): void { /* no discovery caches */ }
  resolveSessionFile(_projectDir: string, _sessionId: string, _homeDir: string): string | null { return null }
  resolveActiveSessionFile(_projectDir: string, _sessionId: string | null, _homeDir: string): string | null { return null }
  findSessionFileById(_sessionId: string, _homeDir: string): string | null { return null }

  // 3. JSONL parsing — graceful no-ops
  extractTurns(_sessionFile: string): AgentTurnInfo[] { return [] }
  hasFileEdits(_sessionFile: string): boolean { return false }
  extractEditedFiles(_sessionFile: string): string[] { return [] }
  /** Unknown whether Codex tolerates unknown record types — assume not, returns false. */
  appendCustomTitle(_sessionFile: string, _sessionId: string, _title: string): boolean { return false }
  getSessionTitle(_sessionFile: string): string | null { return null }
  listActivePids(_homeDir: string): { pid: number; sessionId: string }[] { return [] }
  readSessionModelInfo(_sessionFile: string): SessionModelInfo | null { return null }
  readEffortLevel(_projectDir: string, _homeDir: string): string | null { return null }

  // 4. CLI invocation — THROWS because it sits on the actual spawn path
  buildLaunchCommand(_sel: MenuSelection, _mode: LaunchMode, _opts?: { dockerContextDir?: string; skipPermissions?: boolean }): LaunchCommand {
    throw NOT_IMPLEMENTED()
  }
  buildExecCommand(_prompt: string, _model: string, _opts?: ExecOptions): ExecCommand {
    throw NOT_IMPLEMENTED()
  }

  // 5. TUI patterns — placeholder never-match regex set
  readonly ttyPatterns: AgentTtyPatterns = CODEX_TTY_PATTERNS

  // 6. Slash — Codex has no `/rename` equivalent documented
  renameSlashCommand(name: string): string | null { return codexRenameSlash(name) }

  // 7. Permissions — Codex config.toml — not implemented
  permissionConfigPaths(_projectDir: string, _homeDir: string): string[] { return [] }
}
