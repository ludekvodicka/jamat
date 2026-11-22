import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { AntigravityHistoryMigrator } from './antigravityHistoryMigrator'
import { AntigravitySessionSource } from './antigravitySessionSource'
import { AntigravitySummariesDb } from './antigravitySummariesDb'

describe('lib-orchestrator/projectManager/providers/antigravity', () => {
  const roots: string[] = []

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jamat-agy-pm-'))
    roots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function seedDb(home: string, rows: Array<{
    id: string
    title?: string
    preview?: string
    modified: string
    input?: string
    workspaces: string[]
    status?: string
    parent?: string
    depth?: number
    agentName?: string
  }>): void {
    const db = new DatabaseSync(join(home, 'conversation_summaries.db'))
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT '',
      preview text NOT NULL DEFAULT '',
      last_modified_time datetime NOT NULL,
      last_user_input_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT '',
      not_fully_idle numeric NOT NULL DEFAULT 0,
      parent_conversation_id text NOT NULL DEFAULT '',
      nesting_depth integer NOT NULL DEFAULT 0,
      agent_name text NOT NULL DEFAULT ''
    )`)
    const insert = db.prepare(`INSERT INTO conversation_summaries
      (conversation_id, title, preview, last_modified_time, last_user_input_time, workspace_uris, status, not_fully_idle, parent_conversation_id, nesting_depth, agent_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of rows) {
      insert.run(
        row.id,
        row.title ?? '',
        row.preview ?? '',
        row.modified,
        row.input ?? row.modified,
        JSON.stringify(row.workspaces.map((dir) => pathToFileURL(dir).href)),
        row.status ?? 'CASCADE_RUN_STATUS_IDLE',
        row.status === 'CASCADE_RUN_STATUS_RUNNING' ? 1 : 0,
        row.parent ?? '',
        row.depth ?? 0,
        row.agentName ?? '',
      )
    }
    db.close()
  }

  it('lists top-level Antigravity sessions for a project, skips subagents, and reports latestActivity', async () => {
    const root = tempDir()
    const home = join(root, 'agy-home')
    const projectA = join(root, 'ProjectA')
    const projectB = join(root, 'ProjectB')
    mkdirSync(home, { recursive: true })
    mkdirSync(projectA, { recursive: true })
    mkdirSync(projectB, { recursive: true })
    seedDb(home, [
      {
        id: 'conv-1',
        title: 'Build feature',
        preview: 'build the feature',
        modified: '2026-11-21 20:00:00+00:00',
        input: '2026-11-21 19:00:00+00:00',
        workspaces: [projectA],
      },
      {
        id: 'conv-2',
        title: 'Active task',
        preview: 'working',
        modified: '2026-11-21 21:00:00+00:00',
        workspaces: [projectA],
        status: 'CASCADE_RUN_STATUS_RUNNING',
      },
      {
        id: 'sub-1',
        title: 'Subagent',
        modified: '2026-11-21 21:05:00+00:00',
        workspaces: [projectA],
        parent: 'conv-2',
        depth: 1,
        agentName: 'research',
      },
      {
        id: 'conv-other',
        title: 'Other project',
        modified: '2026-11-21 22:00:00+00:00',
        workspaces: [projectB],
      },
    ])

    const source = new AntigravitySessionSource({ antigravityHome: home })
    const sessions = await source.listProjectSessions(projectA, { limit: 10 })
    expect(sessions.map((item) => ({
      agentId: item.agentId,
      id: item.nativeSessionId,
      title: item.title,
      active: item.active,
    }))).toEqual([
      { agentId: 'antigravity', id: 'conv-2', title: 'Active task', active: true },
      { agentId: 'antigravity', id: 'conv-1', title: 'Build feature', active: false },
    ])
    expect(await source.latestActivity(projectA)).toBe(Date.parse('2026-11-21T21:00:00+00:00'))
    expect(await source.latestActivity(join(root, 'Missing'))).toBeNull()
    expect(AntigravitySummariesDb.childrenOf(home, 'conv-2').map((row) => row.conversationId)).toEqual(['sub-1'])
  })

  it('enumerates brain directories and conversation db files for deletion without touching conversation_summaries.db', async () => {
    const root = tempDir()
    const home = join(root, 'agy-home')
    const project = join(root, 'ProjectA')
    mkdirSync(join(home, 'brain', 'conv-1'), { recursive: true })
    mkdirSync(join(home, 'brain', 'sub-1'), { recursive: true })
    mkdirSync(join(home, 'conversations'), { recursive: true })
    writeFileSync(join(home, 'conversations', 'conv-1.db'), 'db')
    seedDb(home, [
      { id: 'conv-1', modified: '2026-11-21 20:00:00+00:00', workspaces: [project] },
      { id: 'sub-1', modified: '2026-11-21 20:01:00+00:00', workspaces: [], parent: 'conv-1', depth: 1 },
    ])

    const migrator = new AntigravityHistoryMigrator({ antigravityHome: home })
    expect(await migrator.preflight(project, join(root, 'Renamed'))).toEqual({ ok: true })
    const files = await migrator.enumerateProjectFiles(project)
    expect(files).toEqual([
      join(home, 'brain', 'conv-1'),
      join(home, 'brain', 'sub-1'),
      join(home, 'conversations', 'conv-1.db'),
    ].sort())
  })

  it('invalidates statKey when the SQLite WAL file changes', () => {
    const root = tempDir()
    const home = join(root, 'agy-home')
    mkdirSync(home, { recursive: true })
    seedDb(home, [])

    const before = AntigravitySummariesDb.statKey(home)
    expect(before).not.toBeNull()
    writeFileSync(join(home, 'conversation_summaries.db-wal'), 'wal-frame-1')
    const afterWal = AntigravitySummariesDb.statKey(home)
    expect(afterWal).not.toBe(before)
    writeFileSync(join(home, 'conversation_summaries.db-wal'), 'wal-frame-1-plus-more')
    expect(AntigravitySummariesDb.statKey(home)).not.toBe(afterWal)
  })
})
