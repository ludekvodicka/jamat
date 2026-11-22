import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { ProviderTranscriptView } from '../../projectManager/providerTranscriptView'
import { SessionTasks } from '../sessionTasks'

describe('lib-orchestrator/sessionTasks/antigravity', () => {
  const roots: string[] = []

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jamat-agy-tasks-'))
    roots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('lists Antigravity background shells and subagents, and reads shell logs and subagent transcripts', async () => {
    const root = tempDir()
    const home = join(root, 'agy-home')
    const parentId = 'parent-conv-1'
    const childId = 'child-conv-1'
    const parentLogs = join(home, 'brain', parentId, '.system_generated', 'logs')
    const parentTasks = join(home, 'brain', parentId, '.system_generated', 'tasks')
    const childLogs = join(home, 'brain', childId, '.system_generated', 'logs')
    mkdirSync(parentLogs, { recursive: true })
    mkdirSync(parentTasks, { recursive: true })
    mkdirSync(childLogs, { recursive: true })

    writeFileSync(join(parentLogs, 'transcript.jsonl'), [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-21T16:00:00Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"pnpm test"', toolSummary: '"Run test suite"' } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-21T16:00:01Z',
        content: `Created At: 2026-11-21T17:00:01+01:00\nTool is running as a background task with task id: ${parentId}/task-2\nTask Description: pnpm test\nLog output:\nrunning...`,
      }),
      JSON.stringify({
        step_index: 3,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T16:00:10Z',
        content: `Task id "${parentId}/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nOK`,
      }),
      '',
    ].join('\n'))
    writeFileSync(join(parentTasks, 'task-2.log'), '\u001b[32mAll tests passed\u001b[0m\n')

    writeFileSync(join(childLogs, 'transcript.jsonl'), [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-21T16:00:02Z',
        content: '<USER_REQUEST>\nInspect codebase modules\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T16:00:05Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1500,
        cache_read_tokens: 500,
        thinking: 'Checking files',
        tool_calls: [{ name: 'read_file', args: { Path: '"Q:/App/index.ts"' } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T16:00:06Z',
        content: 'export const ok = true',
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T16:00:08Z',
        model: 'gemini-4-neon-high',
        content: 'Found index.ts exporting ok.',
      }),
      '',
    ].join('\n'))

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
    db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      childId, 'Researcher', 'Inspect codebase', '2026-11-21 16:00:08+00:00', '2026-11-21 16:00:02+00:00',
      '[]', 'CASCADE_RUN_STATUS_IDLE', 0, parentId, 1, 'Codebase Researcher',
    )
    db.close()

    const view = new ProviderTranscriptView({ antigravityHome: home })
    const tasks = new SessionTasks(view)
    const context = { agentId: 'antigravity' as const, cwd: root, nativeSessionId: parentId }
    const parent = { live: true, busy: false, now: Date.parse('2026-11-21T16:01:00Z') }

    const listing = await tasks.list(context, parent)
    expect(listing.kind).toBe('tasks')
    if (listing.kind !== 'tasks') throw new Error('expected tasks')
    expect(listing.rows).toHaveLength(2)
    expect(listing.rows.find((row) => row.kind === 'shell')).toMatchObject({
      kind: 'shell',
      shellId: 'task-2',
      command: 'pnpm test',
      description: 'Run test suite',
      state: 'done',
    })
    expect(listing.rows.find((row) => row.kind === 'subagent')).toMatchObject({
      kind: 'subagent',
      subagentId: childId,
      agentType: 'Codebase Researcher',
      description: 'Inspect codebase modules',
      model: 'gemini-4-neon-high',
      state: 'done',
    })

    const output = await tasks.shellOutput(context, 'task-2', parent, null)
    expect(output).toMatchObject({
      kind: 'output',
      command: 'pnpm test',
      state: 'done',
      text: 'All tests passed\n',
    })

    const transcript = await tasks.transcript(context, childId, parent, null)
    expect(transcript.kind).toBe('transcript')
    if (transcript.kind !== 'transcript') throw new Error('expected transcript')
    expect(transcript.header).toMatchObject({
      agentType: 'Codebase Researcher',
      model: 'gemini-4-neon-high',
      state: 'done',
      contextTokens: 2000,
    })
    expect(transcript.entries.map((entry) => entry.kind)).toEqual(['prompt', 'thinking', 'tool', 'message'])
  })

  it('classifies truncated background shell output with exit code 0 as done', async () => {
    const root = tempDir()
    const home = join(root, 'agy-home')
    const parentId = 'parent-conv-trunc'
    const parentLogs = join(home, 'brain', parentId, '.system_generated', 'logs')
    mkdirSync(parentLogs, { recursive: true })
    writeFileSync(join(parentLogs, 'transcript.jsonl'), [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-21T16:00:00Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"pnpm test\\necho done"', toolSummary: '"Run full suite"' } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-21T16:00:01Z',
        content: `Tool is running as a background task with task id: ${parentId}/task-1064\nTask Description: pnpm test`,
      }),
      JSON.stringify({
        step_index: 3,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T16:00:15Z',
        content: `Task id "${parentId}/task-1064" finished with result:\nThe tool's output was truncated due to being too long.\n\nHere is a preview with the middle of the output truncated:\nCommand exited with code 0.\n\nCommand output:\nAll passed`,
      }),
      '',
    ].join('\n'))

    const view = new ProviderTranscriptView({ antigravityHome: home })
    const tasks = new SessionTasks(view)
    const listing = await tasks.list(
      { agentId: 'antigravity', cwd: root, nativeSessionId: parentId },
      { live: true, busy: false, now: Date.parse('2026-11-21T16:01:00Z') },
    )
    expect(listing.kind).toBe('tasks')
    if (listing.kind !== 'tasks') throw new Error('expected tasks')
    expect(listing.rows).toHaveLength(1)
    expect(listing.rows[0]).toMatchObject({ kind: 'shell', shellId: 'task-1064', description: 'Run full suite', state: 'done' })
  })
})
