import { BrowserWindow } from 'electron'
import { createReadStream, readdirSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'
import { locateRegionStartLine, fileKey } from '../../../core/menu-core/diff-compose.js'
import { restoreClaudeInTerminal } from './screen-executor'
import { getAppConfig, getMenuDir, getMenuConfigPath } from './ipc-windows'
import { logError } from './logger'
import { registerHandler } from '../shared/typed-ipc'
import { publishTo } from './streams'
import { getAgent, resolveAgentForSessionId } from '../../../core/agents/index.js'
import { DEFAULT_AGENT_ID, SESSION_ID_RE } from '../../../core/types/contracts.js'
import type { SessionInfo, TurnInfo } from '../../../core/types.js'
import { SessionDescriptionManager } from './sessionDescriptionManager'

// Session-tree reads route through the Claude adapter so this module
// stays agent-agnostic at the call site. Today everything is Claude;
// when a per-session agent is threaded in, swap for the resolved agent.
const claudeAgent = getAgent('claude')

export interface SessionSearchMatch {
  sessionId: string
  sessionLabel: string | null
  sessionDate: string
  timestamp: string
  role: 'user' | 'assistant'
  snippet: string
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
        return item.text
      }
    }
  }
  return null
}

async function searchJsonlFile(
  filePath: string,
  query: string,
  sessionId: string,
  sessionLabel: string | null,
  sessionDate: string,
  results: SessionSearchMatch[]
): Promise<void> {
  const lowerQuery = query.toLowerCase()
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'user' && obj.type !== 'assistant') return
        const text = extractText(obj.message?.content)
        if (!text) return
        if (!text.toLowerCase().includes(lowerQuery)) return
        const ts = obj.timestamp ? new Date(obj.timestamp).toISOString() : sessionDate
        const idx = text.toLowerCase().indexOf(lowerQuery)
        const start = Math.max(0, idx - 60)
        const end = Math.min(text.length, idx + query.length + 100)
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\n/g, ' ') + (end < text.length ? '…' : '')
        results.push({ sessionId, sessionLabel, sessionDate, timestamp: ts, role: obj.type as 'user' | 'assistant', snippet })
      } catch { /* skip bad lines */ }
    })
    rl.on('close', resolve)
    rl.on('error', resolve)
  })
}

async function loadJsonlFile(filePath: string): Promise<SessionMessage[]> {
  const messages: SessionMessage[] = []
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'user' && obj.type !== 'assistant') return
        const text = extractText(obj.message?.content)
        if (!text) return
        const ts = obj.timestamp ?? ''
        messages.push({ role: obj.type as 'user' | 'assistant', content: text, timestamp: ts })
      } catch { /* skip bad lines */ }
    })
    rl.on('close', () => resolve(messages))
    rl.on('error', () => resolve(messages))
  })
}

export function registerSessionIpc(): void {
  registerHandler('sessions:search', async (_e, projectDir: string, query: string) => {
    if (!projectDir || !query || query.trim().length < 2) return []
    const projDir = claudeAgent.findProjectDir(projectDir, homedir())
    if (!projDir) return []

    let files: string[]
    try {
      files = readdirSync(projDir).filter(f => f.endsWith('.jsonl'))
    } catch { return [] }

    const sessions = claudeAgent.listSessionsForProject(projDir, homedir())
    const labelMap = new Map<string, { label: string | null; date: string }>()
    for (const s of sessions) {
      labelMap.set(s.sessionId, {
        label: s.slug,
        date: new Date(s.lastActivity).toISOString()
      })
    }

    const results: SessionSearchMatch[] = []
    const promises = files.map(async (file) => {
      const sessionId = file.replace('.jsonl', '')
      const meta = labelMap.get(sessionId)
      const sessionLabel = meta?.label ?? null
      const sessionDate = meta?.date ?? ''
      await searchJsonlFile(join(projDir, file), query, sessionId, sessionLabel, sessionDate, results)
    })

    await Promise.all(promises)
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    return results.slice(0, 300)
  })

  registerHandler('sessions:list', async (_e, projectDir: string) => {
    if (!projectDir) return []
    const projDir = claudeAgent.findProjectDir(projectDir, homedir())
    if (!projDir) return []
    return claudeAgent.listSessionsForProject(projDir, homedir())
  })

  registerHandler('sessions:edit-flags', async (_e, projectDir: string): Promise<Record<string, boolean>> => {
    if (!projectDir) return {}
    const projDir = claudeAgent.findProjectDir(projectDir, homedir())
    if (!projDir) return {}
    const sessions = claudeAgent.listSessionsForProject(projDir, homedir())
    // Cold path cost: O(N) synchronous JSONL scans on the main thread, one
    // per session. hasFileEdits short-circuits at first qualifying
    // tool_use and caches per mtime+size, so subsequent calls are ~free.
    // If a project's session list grows large enough to hitch panel open,
    // move to a streamed/async scan.
    const out: Record<string, boolean> = {}
    for (const s of sessions) {
      out[s.sessionId] = claudeAgent.hasFileEdits(join(projDir, `${s.sessionId}.jsonl`))
    }
    return out
  })

  registerHandler('sessions:load', async (_e, projectDir: string, sessionId: string) => {
    if (!projectDir || !sessionId) return []
    const projDir = claudeAgent.findProjectDir(projectDir, homedir())
    if (!projDir) return []
    const filePath = join(projDir, `${sessionId}.jsonl`)
    return loadJsonlFile(filePath)
  })

  registerHandler('session-description:load', async (_e, sessionId) =>
    SessionDescriptionManager.load(sessionId),
  )

  registerHandler('session-description:save', async (_e, sessionId, description) =>
    SessionDescriptionManager.save(sessionId, description),
  )

  // Persist a session title through its owning adapter. Claude appends a
  // `custom-title` transcript row; Codex appends its session-name index.
  //
  // sessionId is optional: when missing we fall back to the project's most
  // recently-active session. This lets the UI offer Rename on tabs that
  // pre-date the sessionId-in-params propagation (typically tabs created
  // before the fix shipped, or new-session tabs where Claude Code generates
  // the UUID after the tab is already up).
  registerHandler('sessions:rename', async (_e, projectDir, sessionId, name) => {
    if (!projectDir || typeof projectDir !== 'string') {
      return { ok: false, error: `invalid args — projectDir empty/missing (got: ${typeof projectDir})` }
    }
    if (typeof name !== 'string') {
      return { ok: false, error: `invalid args — name not string (got: ${typeof name})` }
    }
    if (!name.trim()) {
      return { ok: false, error: 'invalid args — name is empty after trim' }
    }
    let resolvedSessionId = sessionId && typeof sessionId === 'string' ? sessionId : ''
    if (!resolvedSessionId) {
      const activeFile = claudeAgent.resolveActiveSessionFile(projectDir, null, homedir())
      if (!activeFile) {
        return { ok: false, error: 'no active session found for project' }
      }
      const m = activeFile.match(/[/\\]([0-9a-f-]+)\.jsonl$/i)
      resolvedSessionId = m?.[1] ?? ''
      if (!resolvedSessionId) {
        return { ok: false, error: 'could not extract sessionId from active session file' }
      }
    }
    // Route the write through whichever agent owns this session.
    const owner = getAgent(resolveAgentForSessionId(resolvedSessionId, homedir()) ?? DEFAULT_AGENT_ID)
    const projDir = owner.findProjectDir(projectDir, homedir())
    if (!projDir) return { ok: false, error: 'project dir not resolved' }
    const sessionFile = owner.resolveSessionFile(projDir, resolvedSessionId, homedir())
    if (!sessionFile) return { ok: false, error: 'session transcript not found' }
    const ok = owner.appendCustomTitle(sessionFile, resolvedSessionId, name)
    return ok ? { ok: true, sessionId: resolvedSessionId } : { ok: false, error: 'rename failed (invalid id or missing transcript)' }
  })

  registerHandler('session-changes:get', async (_e, projectDir: string, sessionId?: string): Promise<TurnInfo[]> => {
    if (!projectDir) return []
    try {
      const file = claudeAgent.resolveActiveSessionFile(projectDir, sessionId ?? null, homedir())
      if (!file) return []
      const turns = claudeAgent.extractTurns(file)
      // Attach best-effort real line numbers. Computed fresh on every fetch
      // (the parser cache is keyed on the jsonl, not the edited files, which
      // can change independently). Each edited file is read at most once.
      const contentCache = new Map<string, string | null>()
      const readOnce = (fp: string): string | null => {
        const key = fileKey(fp)
        if (contentCache.has(key)) return contentCache.get(key)!
        let text: string | null = null
        try {
          text = readFileSync(fp, 'utf-8')
        } catch {
          text = null
        }
        contentCache.set(key, text)
        return text
      }
      // NOTE: turns/files are *cached* arrays from extractTurns —
      // mutating `afterStartLine` here writes through to the cache. That's
      // intentional (always recomputed per call), but if a future consumer
      // ever reads the cache via a parallel path, switch to a shallow clone.
      for (const turn of turns) {
        for (const edit of turn.files) {
          // Disjoint compositions glue far-apart regions — real line numbers
          // past the first region would be wrong, so don't anchor them.
          if (edit.disjoint) {
            edit.afterStartLine = null
            continue
          }
          const content = readOnce(edit.filePath)
          edit.afterStartLine = content ? locateRegionStartLine(content, edit.afterText) : null
        }
      }
      return turns
    } catch (err) {
      logError('session-changes', `${err}`)
      return []
    }
  })

  registerHandler(
    'session-changes:locate-region',
    async (_e, filePath: string, afterText: string): Promise<number | null> => {
      if (!filePath || !afterText) return null
      try {
        return locateRegionStartLine(readFileSync(filePath, 'utf-8'), afterText)
      } catch {
        return null
      }
    },
  )

  registerHandler('session-model:get', async (_e, projectDir: string, sessionId?: string) => {
    if (!projectDir || !sessionId || !SESSION_ID_RE.test(sessionId)) return null
    // STRICT: without a sessionId, resolve to nothing — NOT resolveActiveSessionFile's
    // "newest active session in the dir" fallback. On a fresh blank/--continue tab (its id not
    // yet discovered by the pid resolver) that fallback returns a NEIGHBOURING session's .jsonl
    // and leaks its context % onto the new tab (a false "Context N% full" nag the moment it opens
    // idle). The tab re-polls once kickSessionIdResolution pushes the real id into its params.
    // Same strict rule the title path already uses (sessionFileFor in screen-executor).
    const homeDir = homedir()
    const ownerId = resolveAgentForSessionId(sessionId, homeDir)
    if (!ownerId) return null
    const owner = getAgent(ownerId)
    const file = owner.resolveActiveSessionFile(projectDir, sessionId, homeDir)
    if (!file) return null
    return owner.readSessionModelInfo(file, projectDir, homeDir)
  })

  registerHandler('sessions:search-all', async (_e, query) => {
    if (!query || query.trim().length < 2) return []
    // Route the projects-root walk through the Claude adapter so this
    // handler stays agent-agnostic. When Codex ships, the cross-agent
    // version of search-all will iterate all available adapters.
    const claudeProjectsDir = getAgent('claude').sessionsRoot(homedir())
    let projectDirs: string[]
    try {
      projectDirs = readdirSync(claudeProjectsDir)
    } catch { return [] }

    const results: (SessionSearchMatch & { projectDir: string })[] = []
    for (const projDirName of projectDirs) {
      const projDir = join(claudeProjectsDir, projDirName)
      try {
        const stat = statSync(projDir)
        if (!stat.isDirectory()) continue
      } catch { continue }

      let files: string[]
      try {
        files = readdirSync(projDir).filter(f => f.endsWith('.jsonl'))
      } catch { continue }

      const sessions = claudeAgent.listSessionsForProject(projDir, homedir())
      const labelMap = new Map<string, { label: string | null; date: string }>()
      for (const s of sessions) {
        labelMap.set(s.sessionId, { label: s.slug, date: new Date(s.lastActivity).toISOString() })
      }

      const projectMatches: SessionSearchMatch[] = []
      await Promise.all(files.map(async (file) => {
        const sessionId = file.replace('.jsonl', '')
        const meta = labelMap.get(sessionId)
        await searchJsonlFile(join(projDir, file), query, sessionId, meta?.label ?? null, meta?.date ?? '', projectMatches)
      }))

      for (const m of projectMatches) {
        results.push({ ...m, projectDir: projDirName })
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    return results.slice(0, 300)
  })

  registerHandler('sessions:open-in-tab', async (_e, projectDir, sessionId, fork) => {
    if (!projectDir || !sessionId) return false
    try {
      // NOTE: we intentionally do NOT require the session to appear in
      // listSessionsForProject (which enumerates on-disk *transcripts*). A RUNNING
      // session — especially a just-created fork that adopted a new id — is live in
      // ~/.claude/sessions but may not have flushed its <id>.jsonl yet, so that check
      // would wrongly reject it and the Fork action would silently do nothing. If the id
      // really is bogus, `claude -r <id>` fails visibly in the new tab (no fallback).
      const appConfig = getAppConfig()
      if (!appConfig) return false

      const focusedWindow = BrowserWindow.getFocusedWindow()
      if (!focusedWindow) return false

      const folderName = projectDir.replace(/.*[/\\]/, '')
      const terminalId = `screen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // Resume rows infer the agent from the session file's owning
      // adapter — sessions written by Claude live under ~/.claude/, future
      // Codex ones under ~/.codex/. Fallback to Claude when no adapter
      // recognizes the id (e.g. file already on disk for the legacy path).
      const owner = resolveAgentForSessionId(sessionId, homedir()) ?? DEFAULT_AGENT_ID
      publishTo(focusedWindow.webContents, 'screen:open-tab', terminalId, {
        projectDir: projectDir,
        // `fork` → resume the session as a `--fork-session` branch (new id, history kept,
        // parent untouched); otherwise a plain resume into the same session.
        cmd: fork ? 'resume-fork' : 'resume',
        folderName,
        sessionId,
        antiFlicker: true,
        agent: owner,
      })

      return true
    } catch (err) {
      console.error('[ipc-sessions] error:', err)
      return false
    }
  })
}
