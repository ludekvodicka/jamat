import { describe, expect, it, vi } from 'vitest'
import type { ProviderSessionSummary } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import { HistoricSessions } from './historicSessions'

describe('app-client-ui/app/sessions/history/historicSessions', () => {
  it('includes histories beyond 200, joins the local title and activity, and reads the recorded model', async () => {
    const rows: ProviderSessionSummary[] = Array.from({ length: 205 }, (_, i) => ({
      agentId: 'codex', nativeSessionId: `native-${i}`, title: `Provider ${i}`,
      firstUserMessage: null, createdAt: i, lastActivity: i, active: false,
    }))
    const listProjectSessions = vi.fn(async () => ({ ok: true as const, value: { claude: [], codex: rows, merged: rows } }))
    const read = vi.fn(async () => ({ kind: 'ok' as const, info: { model: 'recorded-model', modelLabel: 'Recorded', effortLevel: null, contextTokens: 0, contextWindow: null } }))
    const history = new HistoricSessions({
      listProjects: async () => ({ ok: true, value: { projects: [{ name: 'App', path: 'Q:/Apps/App', lastActivity: null }], entries: [], virtualFolders: [], truncated: false, available: true } }),
      listProjectSessions,
    }, {
      localHistory: vi.fn(),
      historyReferences: async () => ({ ok: true, value: { references: [{ sessionId: 'local', agentId: 'codex', nativeSessionId: 'native-0', title: '014 - Local title', titleParts: { number: '014', name: 'Local title' }, life: 'live' }] } }),
    }, { read })
    const result = await history.project('root', 'App')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(result.value).toHaveLength(205)
    expect(result.value[0]).toMatchObject({ title: '014 - Local title', active: true, model: 'recorded-model' })
    expect(result.value[204]?.title).toBe('Provider 204')
    expect(listProjectSessions).toHaveBeenCalledWith('root', 'App', { limit: Number.MAX_SAFE_INTEGER })
    expect(read).toHaveBeenCalledWith({ agentId: 'codex', cwd: 'Q:/Apps/App', nativeSessionId: 'native-204', launchModel: null })
  })

  it('refuses a removed project before reading transcripts', async () => {
    const listProjectSessions = vi.fn()
    const history = new HistoricSessions({
      listProjects: async () => ({ ok: true, value: { projects: [], entries: [], virtualFolders: [], truncated: false, available: true } }),
      listProjectSessions,
    }, { historyReferences: vi.fn(), localHistory: vi.fn() }, { read: vi.fn() })
    expect(await history.project('root', 'Missing')).toMatchObject({ ok: false, code: 'project-not-found' })
    expect(listProjectSessions).not.toHaveBeenCalled()
  })

  it('filters by last use inclusively before reading local references and models', async () => {
    const rows: ProviderSessionSummary[] = [
      { agentId: 'claude', nativeSessionId: 'older', title: null, firstUserMessage: null, createdAt: 900, lastActivity: 999, active: false },
      { agentId: 'codex', nativeSessionId: 'boundary', title: null, firstUserMessage: null, createdAt: 1, lastActivity: 1_000, active: false },
      { agentId: 'claude', nativeSessionId: 'recent', title: null, firstUserMessage: null, createdAt: 2, lastActivity: 1_001, active: false },
    ]
    const read = vi.fn(async () => ({ kind: 'none' as const, reason: 'not-found' as const }))
    const historyReferences = vi.fn(async () => ({ ok: true as const, value: { references: [] } }))
    const history = new HistoricSessions({
      listProjects: async () => ({ ok: true, value: { projects: [{ name: 'App', path: 'Q:/Apps/App', lastActivity: null }], entries: [], virtualFolders: [], truncated: false, available: true } }),
      listProjectSessions: async () => ({ ok: true, value: { claude: [], codex: [], merged: rows } }),
    }, { historyReferences, localHistory: vi.fn() }, { read })
    const result = await history.project('root', 'App', 1_000)
    if (!result.ok) throw new Error(result.detail)
    expect(result.value.map((row) => row.nativeSessionId)).toEqual(['boundary', 'recent'])
    expect(read.mock.calls).toHaveLength(2)
    expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'older' }))
    read.mockClear()
    historyReferences.mockClear()
    expect(await history.project('root', 'App', 1_002)).toEqual({ ok: true, value: [] })
    expect(read).not.toHaveBeenCalled()
    expect(historyReferences).not.toHaveBeenCalled()
    const all = await history.project('root', 'App', null)
    if (!all.ok) throw new Error(all.detail)
    expect(all.value).toHaveLength(3)
  })

  it('reads AppJamat records without project discovery or transcripts and merges duplicate conversations', async () => {
    const entry = {
      category: { id: 'root', label: 'Root', path: 'Q:/Apps' },
      project: { kind: 'project' as const, categoryId: 'root', projectName: 'App', projectPath: 'Q:/Apps/App' },
      agentId: 'codex' as const, nativeSessionId: 'native', title: 'Live title', model: 'saved-model',
      createdAt: 100, lastActivity: 1_000, active: true,
    }
    const projects = { listProjects: vi.fn(), listProjectSessions: vi.fn() }
    const sessions = { historyReferences: vi.fn(), localHistory: vi.fn(async () => [
      entry,
      { ...entry, title: 'Ended title', createdAt: 10, lastActivity: 1_100, active: false },
      { ...entry, agentId: 'claude' as const, title: 'Other provider', active: false },
      { ...entry, nativeSessionId: 'old', lastActivity: 999, active: false },
      { ...entry, nativeSessionId: 'unknown', lastActivity: null, createdAt: 5_000, active: true },
      { ...entry, nativeSessionId: 'native', lastActivity: null, title: 'Unknown time', active: false },
    ]) }
    const models = { read: vi.fn() }
    const history = new HistoricSessions(projects, sessions, models)
    const groups = await history.appJamat(1_000)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sessions).toHaveLength(2)
    expect(groups[0]?.sessions[0]).toMatchObject({ title: 'Live title', active: true, model: 'saved-model', createdAt: 10, lastActivity: 1_100 })
    expect((await history.appJamat(null))[0]?.sessions).toHaveLength(4)
    expect((await history.appJamat(null))[0]?.sessions.find((row) => row.nativeSessionId === 'unknown'))
      .toMatchObject({ lastActivity: null, active: true })
    expect(projects.listProjects).not.toHaveBeenCalled()
    expect(projects.listProjectSessions).not.toHaveBeenCalled()
    expect(sessions.historyReferences).not.toHaveBeenCalled()
    expect(models.read).not.toHaveBeenCalled()
  })
})
