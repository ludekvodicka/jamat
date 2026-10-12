import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ScriptLogStore } from '../scripts/scriptLogStore'
import { type WorktreeResultRecord, WorktreeResultsStore } from './worktreeResultsStore'

describe('lib-orchestrator/sessionManager/results/worktreeResultsStore', () => {
  const dayConst = 86_400_000
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function harness(): { store: () => WorktreeResultsStore; directory: string; logs: ScriptLogStore; clock: { now: number }; reports: string[] } {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-worktree-results-'))
    created.push(root)
    const directory = join(root, 'worktree-results')
    const logs = new ScriptLogStore(join(root, 'script-logs'))
    const clock = { now: 10 * dayConst }
    const reports: string[] = []
    return {
      store: () => new WorktreeResultsStore(directory, { now: () => clock.now, logs, report: (message) => { reports.push(message) } }),
      directory, logs, clock, reports,
    }
  }

  function result(actionId: string, overrides: Partial<WorktreeResultRecord> = {}): WorktreeResultRecord {
    return {
      ...WorktreeResultsStore.recordOf({
        actionId, action: 'finish', result: 'committed', sessionId: 's1', title: '014 - fix login',
        worktreePath: 'Q:/Work/App/.worktrees/014-fix-login', mainCopy: 'Q:/Work/App', directoryId: '1:2:3', removal: 'removed',
        revisions: [{ repository: 'https://svn.test/repos/app', revision: 51, label: 'receipt' }],
        lines: ['-> committed app:r51'], logs: [], at: 10 * dayConst, caller: { tag: 'run-7' },
      }),
      ...overrides,
    }
  }

  it('answers a result written by an earlier process, filtered by tag, session and acknowledgement', async () => {
    const it_ = harness()
    const first = it_.store()
    await first.put(result('a1'))
    await first.put(result('a2', { tag: null, sessionId: 's2' }))
    expect(await first.acknowledge('a1')).toEqual({ ok: true, value: { actionId: 'a1' } })

    const later = it_.store()
    await later.load()
    expect(later.list({ tag: 'run-7' }).map((record) => record.actionId)).toEqual(['a1'])
    expect(later.list({ sessionId: 's2' }).map(WorktreeResultsStore.dtoOf)).toEqual([expect.objectContaining({ actionId: 'a2', tag: null, holdsLanded: null })])
    expect(later.list({ unacknowledged: true }).map((record) => record.actionId)).toEqual(['a2'])
    expect(later.list({ tag: 'run-7' })[0].acknowledgedAt).toBe(10 * dayConst)
    expect(await later.acknowledge('missing')).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('sweeps acknowledged results after 1 day and others after 30, with their log copies, at the next load', async () => {
    const it_ = harness()
    const store = it_.store()
    await it_.logs.write('s1', 'run-1', 'output')
    await store.put({ ...result('acknowledged'), logs: await store.keepLogs('acknowledged', 's1', [{ runId: 'run-1', title: 'svn update' }]) })
    await store.put(result('fresh'))
    await store.put(result('old', { at: 10 * dayConst - 30 * dayConst }))
    await store.acknowledge('acknowledged')
    expect(existsSync(join(it_.directory, 'acknowledged', 'run-1.log'))).toBe(true)

    it_.clock.now += dayConst
    const later = it_.store()
    await later.load()
    expect(later.list({}).map((record) => record.actionId)).toEqual(['fresh'])
    expect(existsSync(join(it_.directory, 'acknowledged.json'))).toBe(false)
    expect(existsSync(join(it_.directory, 'acknowledged'))).toBe(false)
    expect(existsSync(join(it_.directory, 'old.json'))).toBe(false)
  })

  it('copies the run logs and the conflict brief beside the result and leaves out what is not on disk', async () => {
    const it_ = harness()
    const store = it_.store()
    await it_.logs.write('s1', 'run-1', 'Updated to revision 50.')
    await it_.logs.writeBrief('s1', 'a1', 'C a.txt')

    const logs = await store.keepLogs('a1', 's1', [{ runId: 'run-1', title: 'svn update' }, { runId: 'run-2', title: 'never saved' }])

    expect(logs).toEqual([
      { runId: 'run-1', title: 'svn update', path: join(it_.directory, 'a1', 'run-1.log') },
      { runId: 'a1-conflicts', title: 'conflict brief', path: join(it_.directory, 'a1', 'conflicts.txt') },
    ])
    expect(readFileSync(logs[0].path, 'utf8')).toBe('Updated to revision 50.')
    await it_.logs.removeParent('s1')
    expect(readFileSync(logs[1].path, 'utf8')).toBe('C a.txt')
  })

  it('keeps a delivered line and an acknowledgement when the same result is written again', async () => {
    const it_ = harness()
    const store = it_.store()
    const line = { sessionId: 'coordinator', text: 'wake', state: 'pending' as const, at: null, attempts: 0 }
    await store.put(result('a1', { notify: line }))
    await store.noteNotify(['a1'], 'attempted', 11)
    await store.noteNotify(['a1'], 'delivered', 12)
    await store.acknowledge('a1')

    await store.put(result('a1', { notify: line, removal: 'pending' }))

    expect(store.list({})[0]).toMatchObject({ removal: 'pending', notify: { state: 'delivered', at: 12, attempts: 1 }, acknowledgedAt: 10 * dayConst })
    expect(store.pendingNotifies()).toEqual([])
  })

  it('finishes a pending removal once, and names the pending results of a session', async () => {
    const it_ = harness()
    const store = it_.store()
    await store.put(result('a1', { removal: 'pending' }))
    await store.put(result('a2', { sessionId: 's2', removal: 'pending' }))

    expect(store.pendingRemovalsOf('s1')).toEqual(['a1'])
    await store.removalDone('a1')
    await store.removalDone('a1')

    expect(store.list({ sessionId: 's1' })[0]).toMatchObject({ removal: 'removed', lines: ['-> committed app:r51', '   worktree removed after the session'] })
    expect(store.pendingRemovalsOf('s1')).toEqual([])
  })

  it('leaves alone a file it cannot read, and refuses an id that is not plain', async () => {
    const it_ = harness()
    mkdirSync(it_.directory, { recursive: true })
    writeFileSync(join(it_.directory, 'broken.json'), '{ not json', 'utf8')
    writeFileSync(join(it_.directory, 'other.json'), JSON.stringify({ actionId: 'somebody-else' }), 'utf8')
    const store = it_.store()

    await store.load()

    expect(store.list({})).toEqual([])
    expect(existsSync(join(it_.directory, 'broken.json'))).toBe(true)
    expect(it_.reports).toHaveLength(2)
    await expect(store.put(result('../escape'))).rejects.toThrow(/Not a plain id/)
  })
})
