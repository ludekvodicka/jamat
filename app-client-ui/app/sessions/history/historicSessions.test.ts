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
      historyReferences: async () => ({ ok: true, value: { references: [
        { sessionId: 'local', agentId: 'codex', nativeSessionId: 'native-0', title: '014 - Local title', titleParts: { number: '014', name: 'Local title' }, life: 'ended', endedAt: 5_000 },
        { sessionId: 'running', agentId: 'codex', nativeSessionId: 'native-1', title: '015 - Still running', titleParts: { number: '015', name: 'Still running' }, life: 'live', endedAt: null },
      ] } }),
    }, { read })
    const result = await history.project('root', 'App')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    // 205 provider conversations, minus the one a local record says is still running.
    expect(result.value).toHaveLength(204)
    expect(result.value[0]).toMatchObject({ title: '014 - Local title', active: false, endedAt: 5_000, model: 'recorded-model' })
    expect(result.value.some((row) => row.nativeSessionId === 'native-1')).toBe(false)
    // Nothing is read for a row nobody will see.
    expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'native-1' }))
    expect(result.value[203]?.title).toBe('Provider 204')
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
      createdAt: 100, lastActivity: 1_000, endedAt: null, active: true,
    }
    const projects = { listProjects: vi.fn(), listProjectSessions: vi.fn() }
    const sessions = { historyReferences: vi.fn(), localHistory: vi.fn(async () => [
      entry,
      { ...entry, title: 'Ended title', createdAt: 10, lastActivity: 1_100, endedAt: 1_200, active: false },
      { ...entry, agentId: 'claude' as const, title: 'Other provider', active: false },
      { ...entry, nativeSessionId: 'old', lastActivity: 999, active: false },
      { ...entry, nativeSessionId: 'unknown', lastActivity: null, createdAt: 5_000, active: true },
      { ...entry, nativeSessionId: 'native', lastActivity: null, title: 'Unknown time', active: false },
      { ...entry, nativeSessionId: 'merged', title: 'First run', createdAt: 40, lastActivity: 1_010, endedAt: 1_020, active: false },
      { ...entry, nativeSessionId: 'merged', title: 'Second run', createdAt: 900, lastActivity: 1_300, endedAt: 1_400, active: false },
    ]) }
    const models = { read: vi.fn() }
    const history = new HistoricSessions(projects, sessions, models)
    const groups = await history.appJamat(1_000)
    expect(groups).toHaveLength(1)
    // The codex conversation carries a live record beside its ended ones, so the whole conversation
    // is out: it is running, and this card lists what ended.
    expect(groups[0]?.sessions.map((row) => row.nativeSessionId)).toEqual(['native', 'merged'])
    expect(groups[0]?.sessions[0]).toMatchObject({ agentId: 'claude', title: 'Other provider', active: false })
    // Two ended records of one conversation: the earliest creation, the latest use and the last end.
    expect(groups[0]?.sessions[1]).toMatchObject({ title: 'Second run', createdAt: 40, lastActivity: 1_300, endedAt: 1_400 })
    expect((await history.appJamat(null))[0]?.sessions.map((row) => row.nativeSessionId))
      .toEqual(['native', 'old', 'merged'])
    expect(projects.listProjects).not.toHaveBeenCalled()
    expect(projects.listProjectSessions).not.toHaveBeenCalled()
    expect(sessions.historyReferences).not.toHaveBeenCalled()
    expect(models.read).not.toHaveBeenCalled()
  })
})
