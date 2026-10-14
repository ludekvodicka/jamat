import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProviderSubagentFileRef, ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { FileTail } from '../../shared/fileTail'
import { SessionTasks } from '../sessionTasks'
import type {
  SessionSubagentRow,
  SessionTaskListing,
  SessionTaskParentState,
  SessionTaskRow,
} from '../sessionTasksApi.types'
import { ClaudeShellScan } from './claudeShellScan'
import { ClaudeShellFixtures } from './fixtures/claudeShellFixtures'
import { ClaudeSubagentFixtures } from './fixtures/claudeSubagentFixtures'
import { type ClaudeSubagentMemo, SessionTasksSourceClaude } from './sessionTasksSourceClaude'

describe('lib-orchestrator/sessionTasks/claude/sessionTasksSourceClaude', () => {
  const created: string[] = []
  const parentIdConst = '4fe1fc81-0413-4b4e-9587-23be8cd35f2d'

  function idOf(row: SessionTaskRow): string {
    switch (row.kind) {
      case 'subagent': return row.subagentId
      case 'shell': return row.shellId
      default: throw new Error(`Unknown session task row: ${JSON.stringify(row satisfies never)}`)
    }
  }
  const nowConst = Date.parse('2026-10-12T07:00:00.000Z')
  const busyConst: SessionTaskParentState = { live: true, busy: true, now: nowConst }
  const idleConst: SessionTaskParentState = { live: true, busy: false, now: nowConst }

  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function directory(): string {
    const value = mkdtempSync(join(tmpdir(), 'jamat-session-tasks-'))
    created.push(value)
    return value
  }

  /** One agent file with its meta; `mtimeMs` stands in for the stat the listing would have taken. */
  function agentFile(
    root: string,
    subagentId: string,
    content: string,
    options: { meta?: Record<string, unknown>; workflowId?: string; mtimeMs?: number } = {},
  ): ProviderSubagentFileRef {
    const folder = options.workflowId === undefined ? root : join(root, 'workflows', `wf_${options.workflowId}`)
    mkdirSync(folder, { recursive: true })
    const file = join(folder, `agent-${subagentId}.jsonl`)
    writeFileSync(file, content, 'utf8')
    let metaFile: string | null = null
    if (options.meta !== undefined) {
      metaFile = join(folder, `agent-${subagentId}.meta.json`)
      writeFileSync(metaFile, JSON.stringify(options.meta), 'utf8')
    }
    const stats = statSync(file)
    return {
      agentId: 'claude',
      subagentId,
      file,
      mtimeMs: options.mtimeMs ?? stats.mtimeMs,
      size: stats.size,
      metaFile,
      spawnKey: null,
      workflowId: options.workflowId ?? null,
      thread: null,
    }
  }

  async function rowsOf(
    refs: readonly ProviderSubagentFileRef[],
    parent: SessionTaskParentState,
    memo: ClaudeSubagentMemo = new Map(),
  ): Promise<SessionSubagentRow[]> {
    return (await new SessionTasksSourceClaude().list(refs, parent, memo)).rows
  }

  it('lists the agent cut from a real session as done, with its meta description', async () => {
    const ref = agentFile(
      directory(),
      ClaudeSubagentFixtures.realAgentIdConst,
      ClaudeSubagentFixtures.realAgent(),
      { meta: ClaudeSubagentFixtures.realAgentMetaConst, mtimeMs: nowConst },
    )

    expect(await rowsOf([ref], busyConst)).toEqual([{
      kind: 'subagent',
      subagentId: 'ac219003d875267a2',
      agentType: 'pp:research:repo-research-analyst',
      description: 'Jamat transcript readers research',
      depth: 1,
      parentSubagentId: null,
      state: 'done',
      startedAt: Date.parse('2026-10-12T06:01:52.660Z'),
      endedAt: Date.parse('2026-10-12T06:05:50.708Z'),
      model: 'claude-opus-5-5',
      step: null,
    }])
  })

  it('lists an agent ending in either interrupt marker as stopped', async () => {
    const root = directory()
    const rows = await rowsOf([
      agentFile(root, 'a01', ClaudeSubagentFixtures.prompt('Look around')
        + ClaudeSubagentFixtures.interrupted('[Request interrupted by user]')),
      agentFile(root, 'a02', ClaudeSubagentFixtures.prompt('Look around')
        + ClaudeSubagentFixtures.toolUse('Bash', { command: 'pnpm test' })
        + ClaudeSubagentFixtures.interrupted('[Request interrupted by user for tool use]')),
    ], busyConst)

    expect(rows.map((row) => [row.subagentId, row.state, row.step]).sort()).toEqual([
      ['a01', 'stopped', null],
      ['a02', 'stopped', null],
    ])
  })

  // This planning agent's own last line once quoted the marker inside a Bash input. A substring
  // test would have called a working agent stopped.
  it('lists an agent whose last tool call quotes the marker as running', async () => {
    const ref = agentFile(directory(), 'a03', ClaudeSubagentFixtures.prompt('Grep the transcripts')
      + ClaudeSubagentFixtures.toolUse('Bash', { command: 'grep -c "[Request interrupted by user" *.jsonl' }))

    expect(await rowsOf([ref], busyConst)).toEqual([expect.objectContaining({
      state: 'running',
      step: 'Bash grep -c "[Request interrupted by user" *.jsonl',
      endedAt: null,
    })])
  })

  it('lists an agent that ended on an API error as failed', async () => {
    const ref = agentFile(directory(), 'a04', ClaudeSubagentFixtures.prompt('Plan it')
      + ClaudeSubagentFixtures.apiError('2026-10-12T06:30:00.000Z')
      + ClaudeSubagentFixtures.attachment())

    expect(await rowsOf([ref], idleConst)).toEqual([expect.objectContaining({
      state: 'failed',
      endedAt: Date.parse('2026-10-12T06:30:00.000Z'),
      model: null,
    })])
  })

  it('lists an unsettled agent of an idle parent as unfinished after two quiet minutes', async () => {
    const root = directory()
    const content = ClaudeSubagentFixtures.prompt('Read it')
      + ClaudeSubagentFixtures.toolUse('Read', { file_path: 'docs/architecture/lib-orchestrator.md' })
    const stale = agentFile(root, 'a05', content, { mtimeMs: nowConst - 180_000 })
    const fresh = agentFile(root, 'a06', content, { mtimeMs: nowConst - 30_000 })

    const rows = await rowsOf([stale, fresh], idleConst)

    expect(rows.map((row) => [row.subagentId, row.state, row.step])).toEqual([
      ['a06', 'running', 'Read docs/architecture/lib-orchestrator.md'],
      ['a05', 'unfinished', 'Read docs/architecture/lib-orchestrator.md'],
    ])
    expect(await rowsOf([fresh], { ...idleConst, live: false }))
      .toEqual([expect.objectContaining({ state: 'unfinished' })])
  })

  it('names the parent of a depth-2 agent and types a workflow agent as workflow', async () => {
    const root = directory()
    const nested = agentFile(root, 'a07', ClaudeSubagentFixtures.prompt('Translate'), {
      meta: {
        agentType: 'fork',
        description: 'Translate voices area',
        toolUseId: 'toolu_016okWx6WqUXrJimVcqboe11',
        parentAgentId: 'a4425fb5c1dca0de9',
        spawnDepth: 2,
        model: 'inherit',
      },
      mtimeMs: nowConst - 1_000,
    })
    const workflow = agentFile(
      root,
      'a08',
      ClaudeSubagentFixtures.prompt(`\nYou are building ONE page.\n${'x'.repeat(8_000)}`),
      { meta: { agentType: 'workflow-subagent' }, workflowId: 'a39acbe7-b93', mtimeMs: nowConst - 2_000 },
    )

    expect(await rowsOf([nested, workflow], busyConst)).toEqual([
      expect.objectContaining({
        subagentId: 'a07',
        agentType: 'fork',
        depth: 2,
        parentSubagentId: 'a4425fb5c1dca0de9',
        model: null,
      }),
      expect.objectContaining({
        subagentId: 'a08',
        agentType: 'workflow',
        description: 'You are building ONE page.',
        depth: 1,
      }),
    ])
  })

  it('reads the newest 60 of 70 files and counts the other 10 as older', async () => {
    const root = directory()
    const refs = Array.from({ length: 70 }, (_, index) => agentFile(
      root,
      `a${String(index).padStart(3, '0')}`,
      ClaudeSubagentFixtures.prompt('Work') + ClaudeSubagentFixtures.toolUse('Bash', { command: 'ls' }),
      { mtimeMs: nowConst - index * 1_000 },
    ))
    const tails = vi.spyOn(FileTail, 'readBounded')

    const listed = await new SessionTasksSourceClaude().list(refs, busyConst, new Map())

    expect(listed.rows).toHaveLength(60)
    expect(listed.unread).toBe(10)
    expect(tails.mock.calls.map(([file]) => file).sort()).toEqual(refs.slice(0, 60).map((ref) => ref.file).sort())
    expect(SessionTasks.listing(listed.rows, listed.unread)).toEqual(expect.objectContaining({
      olderFinished: 10,
      catchingUp: false,
    }))
  })

  it('reads nothing again while the stat key holds, and again once it moves', async () => {
    const ref = agentFile(directory(), 'a09', ClaudeSubagentFixtures.realAgent(), {
      meta: ClaudeSubagentFixtures.realAgentMetaConst,
    })
    const memo: ClaudeSubagentMemo = new Map()
    await rowsOf([ref], busyConst, memo)
    const tails = vi.spyOn(FileTail, 'readBounded')

    expect(await rowsOf([ref], busyConst, memo)).toEqual([expect.objectContaining({ state: 'done' })])
    expect(tails).not.toHaveBeenCalled()

    await rowsOf([{ ...ref, mtimeMs: ref.mtimeMs + 1 }], busyConst, memo)
    expect(tails).toHaveBeenCalledTimes(1)
  })

  it('leaves out a file that vanished between the listing and the read', async () => {
    const root = directory()
    const ref = agentFile(root, 'a10', ClaudeSubagentFixtures.prompt('Work'))
    rmSync(ref.file)

    expect(await rowsOf([ref], busyConst)).toEqual([])
  })

  it('puts running rows first and keeps the newest 50 settled ones', () => {
    const row = (index: number, state: SessionSubagentRow['state']): SessionSubagentRow => ({
      kind: 'subagent',
      subagentId: `a${index}`,
      agentType: 'Explore',
      description: '',
      depth: 1,
      parentSubagentId: null,
      state,
      startedAt: 0,
      endedAt: null,
      model: null,
      step: null,
    })
    const rows = [
      ...Array.from({ length: 55 }, (_, index) => row(index, 'done')),
      row(99, 'running'),
    ]

    const listing = SessionTasks.listing(rows, 3)

    expect(listing.kind === 'tasks' && listing.rows.map(idOf).slice(0, 2)).toEqual(['a99', 'a0'])
    expect(listing.kind === 'tasks' && listing.rows).toHaveLength(51)
    expect(listing.kind === 'tasks' && listing.olderFinished).toBe(8)
  })

  describe('with the parent transcript scan', () => {
    const unsettled = ClaudeSubagentFixtures.prompt('Watch it', '2026-10-12T06:00:00.000Z')
      + ClaudeSubagentFixtures.toolUse('Bash', { command: 'sleep 600' }, '2026-10-12T06:00:10.000Z')

    function parentFile(root: string, content: string): ProviderTranscriptRef {
      const file = join(root, `${parentIdConst}.jsonl`)
      writeFileSync(file, content, 'utf8')
      const stats = statSync(file)
      return { agentId: 'claude', nativeSessionId: parentIdConst, file, mtimeMs: stats.mtimeMs, size: stats.size }
    }

    async function listingOf(
      refs: readonly ProviderSubagentFileRef[],
      parentRef: ProviderTranscriptRef | null,
      parent: SessionTaskParentState,
    ): Promise<Extract<SessionTaskListing, { kind: 'tasks' }>> {
      const tasks = new SessionTasks({
        subagentFiles: () => Promise.resolve(refs),
        resolve: () => Promise.resolve(parentRef),
        claudeShellOutputFile: () => Promise.resolve(null),
      })
      const listing = await tasks.list({ agentId: 'claude', cwd: 'Q:/work/app', nativeSessionId: parentIdConst }, parent)
      if (listing.kind !== 'tasks') throw new Error(`Expected tasks, got ${JSON.stringify(listing)}`)
      return listing
    }

    it('lists an unsettled agent as stopped when a newer killed notification names it', async () => {
      const root = directory()
      const agent = agentFile(root, 'a0f8bc8408b69da4e', unsettled, { mtimeMs: nowConst - 1_000 })
      const parentRef = parentFile(root, ClaudeShellFixtures.notification('a0f8bc8408b69da4e', 'killed', '2026-10-12T06:00:20.000Z'))

      expect((await listingOf([agent], parentRef, busyConst)).rows).toEqual([expect.objectContaining({
        subagentId: 'a0f8bc8408b69da4e',
        state: 'stopped',
        endedAt: Date.parse('2026-10-12T06:00:20.000Z'),
        step: null,
      })])
    })

    it('keeps the file state when the notification is older than its last record', async () => {
      const root = directory()
      const agent = agentFile(root, 'a0f8bc8408b69da4e', unsettled, { mtimeMs: nowConst - 1_000 })
      const parentRef = parentFile(root, ClaudeShellFixtures.notification('a0f8bc8408b69da4e', 'killed', '2026-10-12T06:00:05.000Z'))

      expect((await listingOf([agent], parentRef, busyConst)).rows).toEqual([expect.objectContaining({
        state: 'running',
        step: 'Bash sleep 600',
      })])
      expect((await listingOf([agent], parentRef, { ...idleConst, live: false })).rows)
        .toEqual([expect.objectContaining({ state: 'unfinished' })])
    })

    it('never lets a notification override an agent file that settled on its own', async () => {
      const root = directory()
      const agent = agentFile(root, 'a01', ClaudeSubagentFixtures.realAgent(), { mtimeMs: nowConst })
      const parentRef = parentFile(root, ClaudeShellFixtures.notification('a01', 'killed', '2026-10-12T07:00:00.000Z'))

      expect((await listingOf([agent], parentRef, busyConst)).rows).toEqual([expect.objectContaining({ state: 'done' })])
    })

    it('lists the running shells after the running agents, and the finished ones merged by their end', async () => {
      const root = directory()
      const running = agentFile(root, 'a01', unsettled, { mtimeMs: nowConst - 1_000 })
      const done = agentFile(root, 'a02', ClaudeSubagentFixtures.prompt('Look')
        + ClaudeSubagentFixtures.finalText('Found it', '2026-10-12T06:00:30.000Z'), { mtimeMs: nowConst - 2_000 })
      const parentRef = parentFile(root, [
        ClaudeShellFixtures.bashUse('toolu_1', { command: 'pnpm test', run_in_background: true }, '2026-10-12T06:00:00.000Z'),
        ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-12T06:00:01.000Z'),
        ClaudeShellFixtures.bashUse('toolu_2', { command: 'pnpm build', description: 'Build it' }, '2026-10-12T06:00:02.000Z'),
        ClaudeShellFixtures.launch('toolu_2', 'b2', '2026-10-12T06:00:03.000Z'),
        ClaudeShellFixtures.notification('b2', 'completed', '2026-10-12T06:00:40.000Z'),
      ].join(''))

      const listing = await listingOf([running, done], parentRef, busyConst)

      expect(listing.rows.map((row) => [idOf(row), row.state])).toEqual([
        ['a01', 'running'],
        ['b1', 'running'],
        ['b2', 'done'],
        ['a02', 'done'],
      ])
      expect(listing.rows[2]).toMatchObject({ kind: 'shell', command: 'pnpm build', description: 'Build it' })
      expect(listing.catchingUp).toBe(false)
    })

    it('lists 50 of 120 finished shells and counts the other 70 as older', async () => {
      const root = directory()
      const at = (second: number): string => new Date(nowConst - 3_600_000 + second * 1_000).toISOString()
      const lines = Array.from({ length: 120 }, (_, index) => [
        ClaudeShellFixtures.bashUse(`toolu_${index}`, { command: `echo ${index}` }, at(index * 3)),
        ClaudeShellFixtures.launch(`toolu_${index}`, `b${index}`, at(index * 3 + 1)),
        ClaudeShellFixtures.notification(`b${index}`, 'completed', at(index * 3 + 2)),
      ].join(''))

      const listing = await listingOf([], parentFile(root, lines.join('')), idleConst)

      expect(listing.rows).toHaveLength(50)
      expect(listing.olderFinished).toBe(70)
      expect(listing.rows.slice(0, 2).map(idOf)).toEqual(['b119', 'b118'])
    })

    it('says it is catching up while the scan trails the parent transcript', async () => {
      const root = directory()
      const parentRef = parentFile(root, ClaudeShellFixtures.filler(ClaudeShellScan.maxBytesPerCallConst * 2 + 1_000))

      expect((await listingOf([], parentRef, idleConst)).catchingUp).toBe(true)
      expect((await listingOf([], parentRef, idleConst)).catchingUp).toBe(true)
    })

    it('lists no shells when the parent transcript is not found', async () => {
      const root = directory()
      const agent = agentFile(root, 'a01', unsettled, { mtimeMs: nowConst - 1_000 })

      expect(await listingOf([agent], null, busyConst)).toMatchObject({
        rows: [expect.objectContaining({ subagentId: 'a01', state: 'running' })],
        olderFinished: 0,
        catchingUp: false,
      })
    })
  })
})
