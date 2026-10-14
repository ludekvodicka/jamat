import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderTranscriptView, type ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { FileTail } from '../../shared/fileTail'
import { SessionTasks } from '../sessionTasks'
import type { SessionSubagentRow, SessionTaskParentState } from '../sessionTasksApi.types'
import { CodexChildFixtures } from './fixtures/codexChildFixtures'
import { type CodexSubagentMemo, SessionTasksSourceCodex } from './sessionTasksSourceCodex'

describe('lib-orchestrator/sessionTasks/codex/sessionTasksSourceCodex', () => {
  const created: string[] = []
  const parentConst = CodexChildFixtures.parentThreadIdConst
  const sessionStartConst = new Date(2026, 9, 11, 20, 0, 0)
  const nowConst = sessionStartConst.getTime() + 3_600_000
  const busyConst: SessionTaskParentState = { live: true, busy: true, now: nowConst }
  const idleConst: SessionTaskParentState = { live: true, busy: false, now: nowConst }

  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function directory(): string {
    const value = mkdtempSync(join(tmpdir(), 'jamat-session-tasks-codex-'))
    created.push(value)
    return value
  }

  function at(minutes: number): Date {
    return new Date(sessionStartConst.getTime() + minutes * 60_000)
  }

  /** One child rollout as the provider view hands it over; `mtimeMs` stands in for its stat. */
  function childRef(home: string, threadId: string, content: string, options: { mtimeMs?: number; nickname?: string } = {}): ProviderSubagentFileRef {
    const file = CodexChildFixtures.write(home, at(5), threadId, content)
    const stats = statSync(file)
    return {
      agentId: 'codex',
      subagentId: threadId,
      file,
      mtimeMs: options.mtimeMs ?? stats.mtimeMs,
      size: stats.size,
      metaFile: null,
      spawnKey: threadId,
      workflowId: null,
      thread: { nickname: options.nickname ?? 'Jason', depth: 1, parentSubagentId: null, startedAt: at(5).getTime() },
    }
  }

  async function rowsOf(refs: readonly ProviderSubagentFileRef[], parent: SessionTaskParentState): Promise<SessionSubagentRow[]> {
    return (await new SessionTasksSourceCodex().list(refs, parent, new Map())).rows
  }

  it('lists a parent\'s two children and its grandchild through the provider view', async () => {
    const home = directory()
    // The view lists day directories up to the real clock, so this family started an hour ago.
    const start = new Date(Math.floor((Date.now() - 3_600_000) / 1_000) * 1_000)
    const after = (minutes: number): Date => new Date(start.getTime() + minutes * 60_000)
    CodexChildFixtures.write(home, start, parentConst,
      CodexChildFixtures.header(parentConst, null, null, '2026-10-11T18:00:00.000Z'))
    CodexChildFixtures.write(home, after(5), CodexChildFixtures.firstChildIdConst, CodexChildFixtures.plainChild(
      CodexChildFixtures.firstChildIdConst, parentConst, 'Jason', CodexChildFixtures.taskComplete('2026-10-11T18:14:08.000Z')))
    CodexChildFixtures.write(home, after(6), CodexChildFixtures.secondChildIdConst,
      CodexChildFixtures.encryptedChild(CodexChildFixtures.secondChildIdConst, parentConst, 'Kuhn'))
    CodexChildFixtures.write(home, after(7), CodexChildFixtures.grandchildIdConst, CodexChildFixtures.plainChild(
      CodexChildFixtures.grandchildIdConst, CodexChildFixtures.firstChildIdConst, 'Erdos', CodexChildFixtures.taskComplete('2026-10-11T18:14:09.000Z')))
    const tasks = new SessionTasks(new ProviderTranscriptView({ claudeHome: directory(), codexHome: home }))

    const listing = await tasks.list({
      agentId: 'codex',
      cwd: CodexChildFixtures.cwdConst,
      nativeSessionId: parentConst,
      startedAt: start.getTime(),
    }, idleConst)

    if (listing.kind !== 'tasks') throw new Error(`Expected tasks, got ${JSON.stringify(listing)}`)
    const byId = new Map(listing.rows.flatMap((row) => row.kind === 'subagent' ? [[row.subagentId, row] as const] : []))
    expect(listing.rows).toHaveLength(3)
    expect(byId.get(CodexChildFixtures.firstChildIdConst)).toMatchObject({
      agentType: 'Jason', depth: 1, parentSubagentId: null, state: 'done', model: 'gpt-6-astra',
    })
    expect(byId.get(CodexChildFixtures.secondChildIdConst)).toMatchObject({ agentType: 'Kuhn', depth: 1, state: 'done' })
    expect(byId.get(CodexChildFixtures.grandchildIdConst)).toMatchObject({
      agentType: 'Erdos', depth: 2, parentSubagentId: CodexChildFixtures.firstChildIdConst,
    })
  })

  it('answers none for a Codex session whose start is not known, without a listing', async () => {
    const subagentFiles = vi.fn(() => Promise.resolve([]))
    const tasks = new SessionTasks({ subagentFiles, resolve: () => Promise.resolve(null), claudeShellOutputFile: () => Promise.resolve(null) })

    expect(await tasks.list({ agentId: 'codex', cwd: 'Q:/x', nativeSessionId: parentConst }, idleConst))
      .toMatchObject({ kind: 'none', code: 'unreadable' })
    expect(subagentFiles).not.toHaveBeenCalled()
  })

  it('maps each ending of the last turn to its state', async () => {
    const home = directory()
    const ending = (id: string, line: string | null, mtimeMs?: number): ProviderSubagentFileRef =>
      childRef(home, id, CodexChildFixtures.plainChild(id, parentConst, 'Jason', line), { mtimeMs })
    const done = ending('01a12c40-0000-7000-8000-000000000001', CodexChildFixtures.taskComplete('2026-10-11T18:15:00.000Z'))
    const stopped = ending('01a12c40-0000-7000-8000-000000000002', CodexChildFixtures.turnAborted('interrupted', '2026-10-11T18:15:00.000Z'))
    const failed = ending('01a12c40-0000-7000-8000-000000000003', CodexChildFixtures.turnAborted('replaced', '2026-10-11T18:15:00.000Z'))
    const open = ending('01a12c40-0000-7000-8000-000000000004', null, nowConst - 30_000)
    const quiet = ending('01a12c40-0000-7000-8000-000000000005', null, nowConst - 180_000)
    const restarted = ending('01a12c40-0000-7000-8000-000000000006',
      CodexChildFixtures.taskComplete('2026-10-11T18:15:00.000Z') + CodexChildFixtures.taskStarted('2026-10-11T18:16:00.000Z'),
      nowConst - 180_000)

    const states = new Map((await rowsOf([done, stopped, failed, open, quiet, restarted], idleConst))
      .map((row) => [row.subagentId, row]))

    expect(states.get(done.subagentId)).toMatchObject({ state: 'done', endedAt: Date.parse('2026-10-11T18:15:00.000Z'), step: null })
    expect(states.get(stopped.subagentId)?.state).toBe('stopped')
    expect(states.get(failed.subagentId)?.state).toBe('failed')
    expect(states.get(open.subagentId)).toMatchObject({
      state: 'running',
      endedAt: null,
      step: 'Shell Get-ChildItem docs/architecture',
    })
    expect(states.get(quiet.subagentId)?.state).toBe('unfinished')
    expect(states.get(restarted.subagentId)?.state).toBe('unfinished')
    expect((await rowsOf([quiet], busyConst))[0].state).toBe('running')
  })

  it('describes a child by the first plaintext line of its task, an encrypted one by its nickname', async () => {
    const home = directory()
    const plain = childRef(home, CodexChildFixtures.firstChildIdConst,
      CodexChildFixtures.plainChild(CodexChildFixtures.firstChildIdConst, parentConst, 'Jason', null))
    const encrypted = childRef(home, CodexChildFixtures.secondChildIdConst,
      CodexChildFixtures.encryptedChild(CodexChildFixtures.secondChildIdConst, parentConst, 'Kuhn'), { nickname: 'Kuhn' })

    const rows = new Map((await rowsOf([plain, encrypted], busyConst)).map((row) => [row.subagentId, row]))

    expect(rows.get(plain.subagentId)?.description).toBe('List the files in docs/architecture and report back.')
    expect(rows.get(encrypted.subagentId)).toMatchObject({ agentType: 'Kuhn', description: 'Kuhn', state: 'done' })
  })

  it('reads nothing again while the stat has not moved', async () => {
    const home = directory()
    const ref = childRef(home, CodexChildFixtures.firstChildIdConst,
      CodexChildFixtures.plainChild(CodexChildFixtures.firstChildIdConst, parentConst, 'Jason', null))
    const source = new SessionTasksSourceCodex()
    const memo: CodexSubagentMemo = new Map()
    const reads = vi.spyOn(FileTail, 'readBounded')

    await source.list([ref], busyConst, memo)
    await source.list([ref], busyConst, memo)
    expect(reads).toHaveBeenCalledTimes(1)

    await source.list([{ ...ref, mtimeMs: ref.mtimeMs + 1 }], busyConst, memo)
    expect(reads).toHaveBeenCalledTimes(2)
    expect(memo.get(ref.file)?.facts.descriptionFinal).toBe(true)
  })

  it('reads the task again while the head ends before it', () => {
    const header = CodexChildFixtures.header('child', parentConst, 'Jason', '2026-10-11T18:00:00.000Z')
      + CodexChildFixtures.taskStarted('2026-10-11T18:00:00.100Z')
    expect(SessionTasksSourceCodex.descriptionOf(header, true)).toEqual({ description: null, final: false })
    expect(SessionTasksSourceCodex.descriptionOf(header, false)).toEqual({ description: null, final: true })
  })

  it('passes over a tagged context block before the task', () => {
    const head = CodexChildFixtures.header('child', parentConst, 'Jason', '2026-10-11T18:00:00.000Z')
      + CodexChildFixtures.plainTask('<recommended_plugins>\nnone\n</recommended_plugins>', '2026-10-11T18:00:00.100Z')
      + CodexChildFixtures.plainTask('Review the diff.', '2026-10-11T18:00:00.200Z')
    expect(SessionTasksSourceCodex.descriptionOf(head, true)).toEqual({ description: 'Review the diff.', final: true })
  })
})
