import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
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

  it('retains the main-copy updater across result rewrites and restart', async () => {
    const h = harness()
    const store = h.store()
    await store.put(result('blocked', { removal: 'pending' }))
    await store.mainUpdated('Q:/Work/App', { revision: 99, by: 'person', at: 100 }, async () => ({ holds: false, reason: 'a still at r40 (normal)' }))
    expect(store.list({})[0].main).toBeUndefined()
    await store.mainUpdated('Q:/Work/App', { revision: 52, by: 'person', at: 123 }, async () => ({ holds: true }))
    await store.put(result('blocked', { removal: 'removed' }))
    const reopened = h.store()
    await reopened.load()
    expect(reopened.list({})[0].main).toEqual({ revision: 52, by: 'person', at: 123 })
    expect(WorktreeResultsStore.dtoOf(reopened.list({})[0]).main).toEqual({ revision: 52, by: 'person', at: 123 })
  })

  it('keeps a proven landing across rewrites of the same revisions and restart, and drops it when they change', async () => {
    const h = harness()
    const store = h.store()
    await store.put(result('proven'))
    await store.put(result('updated'))
    expect(await store.landed('proven')).toBe(true)
    h.clock.now += 1
    expect(await store.landed('proven')).toBe(true)
    await store.mainUpdated('Q:/Work/App', { revision: 52, by: 'person', at: 123 }, async () => ({ holds: true }))
    await store.put(result('proven', { removal: 'pending' }))
    const reopened = h.store()
    await reopened.load()
    expect(reopened.list({}).map((record) => [record.actionId, record.landedAt])).toEqual([['proven', 10 * dayConst], ['updated', 10 * dayConst + 1]])
    await reopened.put(result('proven', { revisions: [{ repository: 'https://svn.test/repos/app', revision: 52, label: 'receipt' }] }))
    expect(reopened.list({}).find((record) => record.actionId === 'proven')?.landedAt).toBeUndefined()
    writeFileSync(join(h.directory, 'odd.json'), JSON.stringify({ ...result('odd'), landedAt: 'yesterday' }))
    const again = h.store()
    await again.load()
    expect(again.list({}).find((record) => record.actionId === 'odd')?.landedAt).toBeUndefined()
  })

  it('keeps the revision of each repository a result published to, as the main copy holds it (UA1-J13-7)', async () => {
    const h = harness()
    const store = h.store()
    await store.put(result('ea-only', { revisions: [{ repository: 'https://svn.test/repos/ea', revision: 7, label: 'receipt' }] }))
    await store.mainUpdated('Q:/Work/App', { revision: 5, by: 'person', at: 123, repositories: [{ repository: 'https://svn.test/repos/app', revision: 5 },
      { repository: 'https://svn.test/repos/ea', revision: 8 }] }, async () => ({ holds: true }))
    const reopened = h.store()
    await reopened.load()
    const main = { revision: 5, by: 'person', at: 123, repositories: [{ repository: 'https://svn.test/repos/ea', revision: 8 }] }
    expect(reopened.list({})[0].main).toEqual(main)
    expect(WorktreeResultsStore.dtoOf(reopened.list({})[0]).main).toEqual(main)
  })

  it('keeps the UPDATE logs with every result it lands, once each, after the parent logs are gone', async () => {
    const h = harness()
    const store = h.store()
    await h.logs.write('s1', 'finish-run', 'finish sync')
    await h.logs.write('s1', 'update-run', 'Updated to revision 52.')
    await store.put(result('landed', { logs: [{ runId: 'finish-run', title: 'svn update', path: 'kept-before' }] }))
    await store.put(result('other-session', { sessionId: 's2', revisions: [{ repository: 'https://svn.test/repos/app', revision: 50, label: 'receipt' }] }))
    await store.put(result('elsewhere', { sessionId: 's3', mainCopy: 'Q:/Work/Other' }))
    const runs = [{ runId: 'finish-run', title: 'svn update' }, { runId: 'update-run', title: 'Update main copy: Update . to r52' }]
    const kept = await store.mainUpdated('Q:/Work/App', { revision: 52, by: 'person', at: 123 }, async () => ({ holds: true }), { parentId: 's1', runs })
    await store.mainUpdated('Q:/Work/App', { revision: 52, by: 'person', at: 124 }, async () => ({ holds: true }), { parentId: 's1', runs })
    await h.logs.removeParent('s1')
    const reopened = h.store()
    await reopened.load()
    const landed = reopened.list({ sessionId: 's1' })[0]
    expect(landed.logs.map((log) => [log.runId, log.title])).toEqual([['finish-run', 'svn update'], ['update-run', 'Update main copy: Update . to r52']])
    expect(readFileSync(landed.logs[1].path, 'utf8')).toBe('Updated to revision 52.')
    expect(reopened.list({ sessionId: 's2' })[0].logs.map((log) => log.runId)).toEqual(['update-run'])
    expect(reopened.list({ sessionId: 's3' })[0].logs).toEqual([])
    expect(kept).toEqual([
      { actionId: 'landed', sessionId: 's1', logs: [{ runId: 'update-run', title: 'Update main copy: Update . to r52', path: join(h.directory, 'landed', 'update-run.log') }] },
      { actionId: 'other-session', sessionId: 's2', logs: [{ runId: 'update-run', title: 'Update main copy: Update . to r52', path: join(h.directory, 'other-session', 'update-run.log') }] },
    ])
  })

  it('leaves a result its first landing: a later UPDATE of the same main copy marks only the results it lands', async () => {
    const h = harness()
    const store = h.store()
    await h.logs.write('w1', 'update-r3', 'Updated to revision 3.')
    await h.logs.write('w2', 'update-r4', 'Updated to revision 4.')
    await store.put(result('w1-finish', { sessionId: 'w1', revisions: [{ repository: 'https://svn.test/repos/app', revision: 3, label: 'receipt' }] }))
    await store.mainUpdated('Q:/Work/App', { revision: 3, by: 'person', at: 100 }, async () => ({ holds: true }),
      { parentId: 'w1', runs: [{ runId: 'update-r3', title: 'Update main copy: Update . to r3' }] })
    await store.put(result('w2-finish', { sessionId: 'w2', revisions: [{ repository: 'https://svn.test/repos/app', revision: 4, label: 'receipt' }] }))
    const gained = await store.mainUpdated('Q:/Work/App', { revision: 4, by: 'agent', at: 200 }, async () => ({ holds: true }),
      { parentId: 'w2', runs: [{ runId: 'update-r4', title: 'Update main copy: Update . to r4' }] })
    const reopened = h.store()
    await reopened.load()
    const first = reopened.list({ sessionId: 'w1' })[0]
    expect(first.main).toEqual({ revision: 3, by: 'person', at: 100 })
    expect(first.logs.map((log) => log.runId)).toEqual(['update-r3'])
    expect(reopened.list({ sessionId: 'w2' })[0].main).toEqual({ revision: 4, by: 'agent', at: 200 })
    expect(gained.map((entry) => entry.actionId)).toEqual(['w2-finish'])
  })

  it('keeps the UPDATE logs of its own session with a result whose landing it could not prove, marked unproven, until an UPDATE proves it', async () => {
    const h = harness()
    const store = h.store()
    await h.logs.write('w1', 'update-1', 'C docs/gone.txt')
    await h.logs.write('w1', 'update-2', 'Updated to revision 4.')
    await store.put(result('w1-finish', { sessionId: 'w1', revisions: [{ repository: 'https://svn.test/repos/app', revision: 4, label: 'receipt' }] }))
    await store.put(result('w2-finish', { sessionId: 'w2', revisions: [{ repository: 'https://svn.test/repos/app', revision: 3, label: 'receipt' }] }))
    const unproven = { holds: false, reason: 'docs/gone.txt is locally deleted' }
    const gained = await store.mainUpdated('Q:/Work/App', { revision: 4, by: 'person', at: 100 }, async () => unproven,
      { parentId: 'w1', runs: [{ runId: 'update-1', title: 'Update main copy: Update . to r4' }] })
    const reopened = h.store()
    await reopened.load()
    const first = reopened.list({ sessionId: 'w1' })[0]
    expect(first.main).toBeUndefined()
    expect(first.mainUnproven).toEqual({ revision: 4, by: 'person', at: 100, reason: 'docs/gone.txt is locally deleted' })
    expect(WorktreeResultsStore.dtoOf(first).mainUnproven).toEqual(first.mainUnproven)
    expect(first.logs.map((log) => [log.runId, log.title])).toEqual([['update-1', 'Update main copy: Update . to r4']])
    expect(readFileSync(first.logs[0].path, 'utf8')).toBe('C docs/gone.txt')
    expect(gained).toEqual([{ actionId: 'w1-finish', sessionId: 'w1', logs: first.logs }])
    const other = reopened.list({ sessionId: 'w2' })[0]
    expect(other.mainUnproven).toBeUndefined()
    expect(other.logs).toEqual([])
    await reopened.put(result('w1-finish', { sessionId: 'w1', revisions: first.revisions, logs: first.logs, removal: 'removed' }))
    expect(reopened.list({ sessionId: 'w1' })[0].mainUnproven).toEqual(first.mainUnproven)

    await reopened.mainUpdated('Q:/Work/App', { revision: 4, by: 'person', at: 200 }, async () => ({ holds: true }),
      { parentId: 'w1', runs: [{ runId: 'update-1', title: 'Update main copy: Update . to r4' }, { runId: 'update-2', title: 'Update main copy: Update . to r4' }] })
    const landed = reopened.list({ sessionId: 'w1' })[0]
    expect(landed.main).toEqual({ revision: 4, by: 'person', at: 200 })
    expect(landed.mainUnproven).toBeUndefined()
    expect(landed.logs.map((log) => log.runId)).toEqual(['update-1', 'update-2'])
  })

  it('drops an unreadable unproven mark at load and keeps the result', async () => {
    const h = harness()
    const store = h.store()
    await store.put(result('a1'))
    const file = join(h.directory, 'a1.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), mainUnproven: { revision: 'four' } }))
    const reopened = h.store()
    await reopened.load()
    expect(reopened.list({})[0]).toMatchObject({ actionId: 'a1' })
    expect(reopened.list({})[0].mainUnproven).toBeUndefined()
  })

  it('recovers immutable attempt logs even after the parent logs and run history disappear', async () => {
    const h = harness()
    const store = h.store()
    await h.logs.write('s1', 'run-1', 'first attempt')
    await store.keepAttempt('a1', 's1', { runId: 'run-1', title: 'svn commit' })
    await h.logs.write('s1', 'run-1', 'changed source')
    await store.keepAttempt('a1', 's1', { runId: 'run-1', title: 'svn commit' })
    const later = h.store()
    const logs = await later.keepLogs('a1', 'missing-parent', [])
    expect(logs).toEqual([{ runId: 'run-1', title: 'svn commit', path: join(h.directory, 'a1/attempts/run-1.log') }])
    expect(readFileSync(logs[0].path, 'utf8')).toBe('first attempt')
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

  it.each(['saved', 'ignored', 'discarded', 'setup'])('keeps acknowledged %s copies for 30 days and longer while memory holds the action', async (bucket) => {
    const it_ = harness()
    const store = it_.store()
    const saved = join(store.savedDirectoryOf('a1'), '..', bucket)
    mkdirSync(saved, { recursive: true })
    writeFileSync(join(saved, 'working'), 'session copy')
    await store.put(result('a1'))
    await store.acknowledge('a1')
    it_.clock.now += 2 * dayConst
    const later = it_.store()
    await later.load()
    expect(readFileSync(join(saved, 'working'), 'utf8')).toBe('session copy')
    it_.clock.now += 29 * dayConst
    const held = new WorktreeResultsStore(it_.directory, { now: () => it_.clock.now, logs: it_.logs, report: () => undefined, heldActionIds: () => new Set(['a1']) })
    await held.load()
    expect(existsSync(saved)).toBe(true)
    await later.sweep()
    expect(existsSync(saved)).toBe(false)
  })

  it('retains results and saved files of quarantined sessions beyond the normal expiry', async () => {
    const h = harness(), store = h.store()
    const row = result('quarantined')
    await store.put(row)
    const saved = join(store.savedDirectoryOf(row.actionId), 'manual.txt')
    mkdirSync(dirname(saved), { recursive: true })
    writeFileSync(saved, 'preserved')
    h.clock.now += 60 * dayConst
    const restored = new WorktreeResultsStore(h.directory, { now: () => h.clock.now, logs: h.logs, report: () => {},
      quarantinedSessionIds: () => new Set([row.sessionId]) })
    await restored.load()
    await restored.sweep()
    expect(restored.list({})).toHaveLength(1)
    expect(readFileSync(saved, 'utf8')).toBe('preserved')
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

  it("keeps the merger's brief as merge.md beside the run logs", async () => {
    const it_ = harness()
    const store = it_.store()
    await it_.logs.write('s1', 'run-1', 'Updated to revision 50.')
    await it_.logs.writeMergeBrief('s1', 'a1', '# Merge the conflicts of t')

    const logs = await store.keepLogs('a1', 's1', [{ runId: 'run-1', title: 'svn update' }])

    expect(logs).toEqual([
      { runId: 'run-1', title: 'svn update', path: join(it_.directory, 'a1', 'run-1.log') },
      { runId: 'a1-merge', title: 'merger brief', path: join(it_.directory, 'a1', 'merge.md') },
    ])
    await it_.logs.removeParent('s1')
    expect(readFileSync(logs[1].path, 'utf8')).toBe('# Merge the conflicts of t')
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

  it('keeps a 31-day-old folder of an action still on a record, and sweeps an orphan one of the same age', async () => {
    const it_ = harness()
    it_.clock.now = 100 * dayConst
    const old = (it_.clock.now - 31 * dayConst) / 1_000
    for (const actionId of ['held', 'orphan']) {
      const saved = new WorktreeResultsStore(it_.directory, { now: () => it_.clock.now, logs: it_.logs, report: () => undefined })
        .savedDirectoryOf(actionId)
      mkdirSync(saved, { recursive: true })
      writeFileSync(join(saved, 'brief.md'), 'copy of the session')
      utimesSync(join(it_.directory, actionId), old, old)
    }
    expect(it_.store().savedDirectoryOf('held')).toBe(join(it_.directory, 'held', 'saved'))
    expect(() => it_.store().savedDirectoryOf('../escape')).toThrow(/Not a plain id/)

    const store = new WorktreeResultsStore(it_.directory, {
      now: () => it_.clock.now, logs: it_.logs, report: () => undefined, heldActionIds: () => new Set(['held']),
    })
    await store.load()

    expect(readFileSync(join(it_.directory, 'held', 'saved', 'brief.md'), 'utf8')).toBe('copy of the session')
    expect(existsSync(join(it_.directory, 'orphan'))).toBe(false)
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
