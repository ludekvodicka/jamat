import { ipcMain } from 'electron'
import { registerHandler } from '../shared/typed-ipc'
import { readFileSync } from 'fs'
import { diffLines } from 'diff'
import {
  detectVcs,
  fetchGitBaseline,
  fetchSvnBaseline,
  listRecentGitHistory,
  preferVcsForFile,
} from '../../../core/menu-core/file-diff-vcs.js'
import {
  composeFileBaselineFromSession,
  sessionHasEditsForFile,
  turnCountForFile,
} from '../../../core/menu-core/file-diff-session.js'
import { getAgent } from '../../../core/agents/index.js'
import { join as joinPath } from 'path'
import { homedir } from 'os'
import { logError } from './logger'
import type {
  DiffBaseline,
  DiffMode,
  DiffOption,
  DiffOptions,
  SessionPoint,
} from '../../../core/types.js'
import type { TurnInfo } from '../../../core/types/session.js'

// Session reads route through the Claude adapter (today's only real
// backend) so call sites stay agent-agnostic.
const claudeAgent = getAgent('claude')

/**
 * Normalize CRLF / lone CR to LF. Disk files on Windows arrive as CRLF, but
 * `git show <ref>:<path>` returns content with whatever line endings git
 * stores internally (typically LF, since core.autocrlf on Windows checks in
 * LF and checks out CRLF). Without normalization every line of a Windows
 * file appears as removed-and-re-added in the diff.
 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

// Compile-time exhaustiveness guard: a new DiffMode variant makes the
// switch's `default` branch a type error instead of silently returning a
// fake "no changes" baseline.
function assertNever(x: never): never {
  throw new Error(`unreachable DiffMode: ${JSON.stringify(x)}`)
}

function countAddedRemoved(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  const parts = diffLines(before, after)
  let added = 0
  let removed = 0
  for (const p of parts) {
    if (!p.added && !p.removed) continue
    const body = p.value.endsWith('\n') ? p.value.slice(0, -1) : p.value
    const count = body.length === 0 ? 0 : body.split('\n').length
    if (p.added) added += count
    else removed += count
  }
  return { added, removed }
}

function formatCommitDate(unixMs: number): string {
  const d = new Date(unixMs)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day}.${month} ${hh}:${mm}`
}

function shortenSubject(s: string, max = 40): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function loadSessionTurns(projectDir: string, sessionId: string | null): { turns: TurnInfo[]; sessionId: string | null } {
  const file = claudeAgent.resolveActiveSessionFile(projectDir, sessionId, homedir())
  if (!file) return { turns: [], sessionId: null }
  try {
    // Recover the sessionId from the resolved file path so the caller can
    // echo it back in get-baseline (especially useful when `sessionId` was
    // null/undefined and we resolved to the active session).
    const m = file.match(/[/\\]([0-9a-f-]+)\.jsonl$/i)
    return { turns: claudeAgent.extractTurns(file), sessionId: m?.[1] ?? null }
  } catch {
    return { turns: [], sessionId: null }
  }
}

/**
 * Find the most recently-active past session of this project that has any
 * edits to `filePath`. Used as a cross-session fallback when the active
 * terminal session doesn't touch a file the user is asking about (e.g. a
 * file developed across multiple sessions, currently inspected from a
 * different session).
 */
function findSessionTouchingFile(projectDir: string, filePath: string, excludeSessionId: string | null): { turns: TurnInfo[]; sessionId: string } | null {
  const projDir = claudeAgent.findProjectDir(projectDir, homedir())
  if (!projDir) return null
  let sessions
  try {
    sessions = claudeAgent.listSessionsForProject(projDir, homedir())
  } catch {
    return null
  }
  // sessions sorted by lastActivity desc — first hit is the most recent
  // session that has the file.
  for (const s of sessions) {
    if (excludeSessionId && s.sessionId === excludeSessionId) continue
    const jsonl = joinPath(projDir, `${s.sessionId}.jsonl`)
    try {
      if (!claudeAgent.hasFileEdits(jsonl)) continue
      const turns = claudeAgent.extractTurns(jsonl)
      if (sessionHasEditsForFile(turns, filePath)) {
        return { turns, sessionId: s.sessionId }
      }
    } catch {}
  }
  return null
}

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function registerFileDiffIpc(): void {
  registerHandler('file-diff:list-options', async (
    _e,
    filePath,
    projectDir,
    sessionId,
  ) => {
      if (typeof filePath !== 'string') {
        return { options: [], defaultMode: { kind: 'off' } }
      }

      const detection = detectVcs(filePath)
      const preferred = preferVcsForFile(detection, filePath)
      const options: DiffOption[] = []

      // ── Working copy: git ──
      if (detection.git && preferred === 'git') {
        const history = listRecentGitHistory(detection.git.repoRoot, 5)
        if (history.length > 0) {
          for (let i = 0; i < history.length; i++) {
            const h = history[i]
            const dateStr = formatCommitDate(h.commitDate)
            const subj = shortenSubject(h.subject)
            const label =
              i === 0
                ? `Since last commit (${h.shortSha}: ${subj}, ${dateStr})`
                : `Since HEAD~${i} (${h.shortSha}: ${subj})`
            options.push({
              mode: i === 0 ? { kind: 'git-head' } : { kind: 'git-head-back', n: i },
              label,
              enabled: true,
              group: 'working-copy',
              meta: { commitDate: h.commitDate, shortSha: h.shortSha },
            })
          }
        } else {
          options.push({
            mode: { kind: 'git-head' },
            label: 'Since last commit (no prior commit)',
            enabled: true,
            group: 'working-copy',
          })
        }
      } else if (detection.git) {
        options.push({
          mode: { kind: 'git-head' },
          label: 'Since last commit (git)',
          enabled: false,
          reason: 'svn baseline is newer for this file',
          group: 'working-copy',
        })
      }

      // ── Working copy: svn ──
      if (detection.svn && preferred === 'svn') {
        const fetch = fetchSvnBaseline(detection.svn.repoRoot, filePath)
        const dateStr = fetch.timestamp ? formatCommitDate(fetch.timestamp) : 'unknown'
        // Enable only when the file is actually under svn version control —
        // otherwise the option is visible but does nothing useful (svn cat
        // returns empty for unversioned files even though the working copy
        // root is detected via the ancestor `.svn/` marker).
        const tracked = fetch.exists && !fetch.error
        options.push({
          mode: { kind: 'svn-base' },
          label: `Since BASE (${dateStr})`,
          enabled: tracked,
          reason: fetch.error ?? (tracked ? undefined : 'File is not under svn version control'),
          group: 'working-copy',
          meta: fetch.timestamp ? { commitDate: fetch.timestamp } : undefined,
        })
      } else if (detection.svn) {
        options.push({
          mode: { kind: 'svn-base' },
          label: 'Since BASE (svn)',
          enabled: false,
          reason: 'git baseline is newer for this file',
          group: 'working-copy',
        })
      }

      if (!detection.git && !detection.svn) {
        options.push({
          mode: { kind: 'git-head' },
          label: 'Since last commit',
          enabled: false,
          reason: 'File is not in a git or svn repository',
          group: 'working-copy',
        })
      }

      // ── Claude session ──
      // Resolve effective session: first try the caller-supplied id (or the
      // project's active session). If that session doesn't touch this file,
      // fall back to the most recent past session that does — important for
      // files developed across multiple sessions where the active terminal
      // happens to be a different conversation.
      let sessionTurns: TurnInfo[] = []
      let hasSession = false
      let effectiveSessionId: string | null = sessionId ?? null
      let crossSessionFallback = false
      if (projectDir) {
        const loaded = loadSessionTurns(projectDir, sessionId ?? null)
        sessionTurns = loaded.turns
        effectiveSessionId = loaded.sessionId
        hasSession = sessionTurns.length > 0
      }
      let fileHasSessionEdits = hasSession && sessionHasEditsForFile(sessionTurns, filePath)
      if (!fileHasSessionEdits && projectDir) {
        const cross = findSessionTouchingFile(projectDir, filePath, effectiveSessionId)
        if (cross) {
          sessionTurns = cross.turns
          effectiveSessionId = cross.sessionId
          fileHasSessionEdits = true
          crossSessionFallback = true
          hasSession = true
        }
      }
      const fileTurnCount = fileHasSessionEdits ? turnCountForFile(sessionTurns, filePath) : 0

      if (fileHasSessionEdits) {
        const labelSuffix = crossSessionFallback ? ' (other session)' : ''
        options.push({
          mode: { kind: 'session-start' },
          label: `Since session start${labelSuffix}`,
          enabled: true,
          group: 'claude-session',
          meta: { sessionId: effectiveSessionId ?? undefined },
        })
        options.push({
          mode: { kind: 'session-last-turn' },
          label: `Since last turn${labelSuffix}`,
          enabled: true,
          group: 'claude-session',
          meta: { sessionId: effectiveSessionId ?? undefined },
        })
        // N=2..5 only if there are at least N turns touching this file.
        for (let n = 2; n <= 5 && n <= fileTurnCount; n++) {
          options.push({
            mode: { kind: 'session-turn-back', n },
            label: `Since ${n} turns ago${labelSuffix}`,
            enabled: true,
            group: 'claude-session',
            meta: { sessionId: effectiveSessionId ?? undefined },
          })
        }
      } else {
        options.push({
          mode: { kind: 'session-start' },
          label: 'Since session start',
          enabled: false,
          reason: hasSession ? 'No edits to this file in active session' : 'No active Claude session',
          group: 'claude-session',
        })
      }

      // ── Off ──
      options.push({
        mode: { kind: 'off' },
        label: 'No diff',
        enabled: true,
        group: 'off',
      })

      // Smart default — avoids landing on "Since last commit" for files
      // that aren't actually committed (which renders as all-`+` and looks
      // like the file is brand new even when the session has meaningful
      // history).
      //
      // Priority:
      //   1. Walk back through session turn-back candidates from the most
      //      recent (`last-turn`, `turn-back 2..N`, `session-start`). Pick
      //      the first baseline whose `beforeText` is non-empty AND differs
      //      from the current file — the smallest meaningful baseline.
      //      Skips candidates that reach back before the file existed
      //      (which would render as all-`+`).
      //   2. Fall back to VCS if it has content for this file (committed
      //      files with no session activity, or session walkback exhausted
      //      without finding a meaningful baseline).
      //   3. Final fallback: `off` (file is brand-new with no history —
      //      render plain so the user sees the content instead of all-`+`).
      let defaultMode: DiffMode = { kind: 'off' }
      let smartDefault: DiffMode | null = null

      if (fileHasSessionEdits) {
        const afterRaw = readFileSafe(filePath)
        if (afterRaw !== null) {
          const normAfter = normalizeNewlines(afterRaw)
          for (let n = 1; n <= fileTurnCount; n++) {
            const point: SessionPoint = n === 1 ? { kind: 'last-turn' } : { kind: 'turn-back', n }
            const r = composeFileBaselineFromSession(sessionTurns, filePath, point, normAfter)
            if (r && r.beforeText !== '' && r.beforeText !== r.afterText) {
              smartDefault = n === 1 ? { kind: 'session-last-turn' } : { kind: 'session-turn-back', n }
              break
            }
          }
          if (!smartDefault) {
            const r = composeFileBaselineFromSession(sessionTurns, filePath, { kind: 'session-start' }, normAfter)
            if (r && r.beforeText !== '' && r.beforeText !== r.afterText) {
              smartDefault = { kind: 'session-start' }
            }
          }
        }
      }

      if (!smartDefault && preferred === 'git' && detection.git) {
        const f = fetchGitBaseline(detection.git.repoRoot, filePath, 'HEAD')
        if (f.exists && f.content.length > 0) smartDefault = { kind: 'git-head' }
      }
      if (!smartDefault && preferred === 'svn' && detection.svn) {
        const f = fetchSvnBaseline(detection.svn.repoRoot, filePath)
        if (f.exists && f.content.length > 0) smartDefault = { kind: 'svn-base' }
      }

      if (smartDefault) defaultMode = smartDefault

      return { options, defaultMode, effectiveSessionId }
    })

  registerHandler('file-diff:get-baseline', async (
    _e,
    filePath,
    mode,
    projectDir,
    sessionId,
  ) => {
      const empty: DiffBaseline = {
        beforeText: '',
        afterText: '',
        label: '',
        addedLines: 0,
        removedLines: 0,
        isRegionOnly: false,
      }
      if (typeof filePath !== 'string' || !mode || typeof mode !== 'object') return empty

      const afterRaw = readFileSafe(filePath)
      if (afterRaw === null) {
        return { ...empty, error: 'Could not read file' }
      }
      // Normalize line endings once at the boundary so every downstream step
      // (substitution, diffLines, render) sees LF-only text.
      const afterText = normalizeNewlines(afterRaw)

      try {
        let beforeText = ''
        let label = ''
        let isRegionOnly = false
        let regionOnlyReason: string | undefined
        let renderedAfter = afterText
        let regionBefore: string | undefined
        let regionAfter: string | undefined
        let disjoint: boolean | undefined

        switch (mode.kind) {
          case 'off': {
            return {
              beforeText: afterText,
              afterText,
              label: 'No diff',
              addedLines: 0,
              removedLines: 0,
              isRegionOnly: false,
            }
          }
          case 'git-head':
          case 'git-head-back': {
            const root = detectVcs(filePath).git
            if (!root) {
              return { ...empty, afterText, error: 'File is not in a git repository' }
            }
            const n = mode.kind === 'git-head-back' ? mode.n : 0
            const ref = n === 0 ? 'HEAD' : `HEAD~${n}`
            const fetch = fetchGitBaseline(root.repoRoot, filePath, ref)
            if (fetch.error) return { ...empty, afterText, error: fetch.error }
            beforeText = fetch.content
            const dateStr = fetch.timestamp ? formatCommitDate(fetch.timestamp) : ''
            label =
              n === 0
                ? `Since last commit${dateStr ? ` (${dateStr})` : ''}`
                : `Since HEAD~${n}${dateStr ? ` (${dateStr})` : ''}`
            break
          }
          case 'svn-base': {
            const root = detectVcs(filePath).svn
            if (!root) {
              return { ...empty, afterText, error: 'File is not in an svn working copy' }
            }
            const fetch = fetchSvnBaseline(root.repoRoot, filePath)
            if (fetch.error) return { ...empty, afterText, error: fetch.error }
            beforeText = fetch.content
            const dateStr = fetch.timestamp ? formatCommitDate(fetch.timestamp) : ''
            label = `Since BASE${dateStr ? ` (${dateStr})` : ''}`
            break
          }
          case 'session-start':
          case 'session-last-turn':
          case 'session-turn-back': {
            if (!projectDir) {
              return { ...empty, afterText, error: 'projectDir required for session baselines' }
            }
            const loaded = loadSessionTurns(projectDir, sessionId ?? null)
            const turns = loaded.turns
            if (turns.length === 0) {
              return { ...empty, afterText, error: 'No active session' }
            }
            const point: SessionPoint =
              mode.kind === 'session-start'
                ? { kind: 'session-start' }
                : mode.kind === 'session-last-turn'
                  ? { kind: 'last-turn' }
                  : { kind: 'turn-back', n: mode.n }
            const result = composeFileBaselineFromSession(turns, filePath, point, afterText)
            if (!result) {
              return { ...empty, afterText, error: 'No session edits for this file' }
            }
            beforeText = result.beforeText
            isRegionOnly = result.isRegionOnly
            regionOnlyReason = result.regionOnlyReason
            renderedAfter = isRegionOnly ? result.afterText : afterText
            regionBefore = result.regionBefore
            regionAfter = result.regionAfter
            disjoint = result.disjoint
            label =
              mode.kind === 'session-start'
                ? 'Since session start'
                : mode.kind === 'session-last-turn'
                  ? 'Since last turn'
                  : `Since ${mode.n} turns ago`
            break
          }
          default:
            return assertNever(mode)
        }

        const normBefore = normalizeNewlines(beforeText)
        const normAfter = normalizeNewlines(renderedAfter)
        const counts = countAddedRemoved(normBefore, normAfter)
        return {
          beforeText: normBefore,
          afterText: normAfter,
          label,
          addedLines: counts.added,
          removedLines: counts.removed,
          isRegionOnly,
          regionOnlyReason,
          regionBefore,
          regionAfter,
          disjoint,
        }
      } catch (err) {
        logError('file-diff', `${err}`)
        return { ...empty, afterText, error: String(err) }
      }
    })
}
