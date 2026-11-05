import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import type { SessionRecord } from './sessionRecord.types'
import { SessionRecordsArchive } from './sessionRecordsArchive'
import { SessionRecordsStore } from './sessionRecordsStore'

describe('lib-orchestrator/sessionManager/records/sessionRecordsArchive', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 100 * day
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function harness(): { file: string; archiveFile: string; snapshots: string; removedLogs: string[]; load: () => Promise<SessionRecordsStore> } {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-records-archive-'))
    roots.push(root)
    const file = join(root, 'session-records.json')
    const snapshots = join(root, 'snapshots')
    const removedLogs: string[] = []
    return {
      file,
      archiveFile: SessionRecordsArchive.fileOf(file),
      snapshots,
      removedLogs,
      load: () => SessionRecordsStore.load(file, { snapshotsDirectory: snapshots, report: () => {},
        removeSessionLogs: async (sessionId) => { removedLogs.push(sessionId) } }),
    }
  }

  function record(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return { sessionId, kind: 'shell', title: sessionId, directory: { mode: 'default' }, binding: null,
      life: 'ended', createdAt: 1, endedAt: now - 8 * day, ...overrides }
  }

  const ids = (records: readonly SessionRecord[]): string[] => records.map((entry) => entry.sessionId)
  const idsIn = (file: string): string[] => existsSync(file) ? ids(JSON.parse(readFileSync(file, 'utf8')).records) : []
  const worktree = { worktreePath: 'Q:/work', branch: 'https://svn.test/work', baseCommit: 'r1', repositoryRoot: 'Q:/main', kind: 'svn' as const }

  it('names its file beside the records file', () => {
    expect(SessionRecordsArchive.fileOf('C:/state/session-records.json')).toBe('C:/state/session-records-archive.json')
  })

  it('moves only old ended records nothing can still reach, archive first and then the records file with a recovery point', async () => {
    const h = harness()
    const store = await h.load()
    for (const entry of [
      record('old'),
      record('recent', { endedAt: now - day }),
      record('no-end', { endedAt: undefined }),
      record('lost', { life: 'lost' }),
      record('in-worktree', { worktree }),
      record('run-parent'),
      record('run', { life: 'live', endedAt: undefined, scriptOf: { sessionId: 'run-parent', phase: 'inner', scriptId: 'requested', name: 'call' } }),
      record('child-parent'),
      record('child', { life: 'live', endedAt: undefined, parent: { sessionId: 'child-parent', kind: 'worker' } }),
      record('landing'),
    ]) await store.put(entry)
    h.removedLogs.length = 0

    const moved = await store.archiveEnded(now, (entry) => entry.sessionId !== 'landing')

    expect(moved).toBe(1)
    expect(ids(store.archived())).toEqual(['old'])
    expect(store.get('old')).toBeNull()
    expect(store.getAny('old')?.sessionId).toBe('old')
    expect(ids(store.list())).not.toContain('old')
    expect(ids(store.listAll())).toEqual([...ids(store.list()), 'old'])
    expect(idsIn(h.archiveFile)).toEqual(['old'])
    expect(idsIn(h.file)).not.toContain('old')
    expect(readdirSync(h.snapshots)).toHaveLength(1)
    expect(h.removedLogs).toEqual([])
    expect(await store.archiveEnded(now, (entry) => entry.sessionId !== 'landing')).toBe(0)
  })

  it('keeps the active copy of a record a cut-short move left in both files', async () => {
    const h = harness()
    writeFileSync(h.file, JSON.stringify({ schemaVersion: 1, savedAt: 1, records: [record('both', { title: 'active' })] }))
    writeFileSync(h.archiveFile, JSON.stringify({ schemaVersion: 1, savedAt: 1, records: [record('both', { title: 'archived' }), record('only')] }))

    const store = await h.load()

    expect(store.get('both')?.title).toBe('active')
    expect(ids(store.archived())).toEqual(['only'])
    expect(ids(store.listAll())).toEqual(['both', 'only'])
    expect(idsIn(h.archiveFile)).toEqual(['only'])
  })

  it('takes a record back out of the archive when the records write is refused', async () => {
    const h = harness()
    const store = await h.load()
    await store.put(record('old'))
    const original = AtomicJsonFile.writeAsync.bind(AtomicJsonFile)
    vi.spyOn(AtomicJsonFile, 'writeAsync').mockImplementation(async (file, value, options) => {
      if (file === h.file) throw new Error('disk full')
      return original(file, value, options)
    })

    expect(await store.archiveEnded(now, () => true)).toBe(0)
    expect(store.get('old')?.sessionId).toBe('old')
    expect(store.archived()).toEqual([])
    expect(idsIn(h.archiveFile)).toEqual([])
  })

  it('restores an archived record to the records file and lets the archive go of it', async () => {
    const h = harness()
    const store = await h.load()
    await store.put(record('old', { title: '014 - old work' }))
    await store.archiveEnded(now, () => true)

    expect(await store.restore('old')).toBe(true)

    expect(store.get('old')?.title).toBe('014 - old work')
    expect(store.archived()).toEqual([])
    expect(idsIn(h.file)).toContain('old')
    expect(idsIn(h.archiveFile)).toEqual([])
    expect(await store.restore('never-archived')).toBe(true)
    const reloaded = await h.load()
    expect(reloaded.get('old')?.sessionId).toBe('old')
  })

  it('keeps a record that is restored while an archive pass is queued, in the records file only', async () => {
    const h = harness()
    const store = await h.load()
    await store.put(record('old'))
    await store.archiveEnded(now, () => true)
    await store.put(record('other'))

    const restoring = store.restore('old')
    const archiving = store.archiveEnded(now, () => true)
    expect(await restoring).toBe(true)
    expect(await archiving).toBe(1)

    expect(store.get('old')?.sessionId).toBe('old')
    expect(ids(store.archived())).toEqual(['other'])
    expect(idsIn(h.file)).toContain('old')
    expect(idsIn(h.archiveFile)).toEqual(['other'])
  })

  it('answers whether its archive was read', async () => {
    const h = harness()
    expect((await h.load()).archiveRead).toBe(true)
    writeFileSync(h.archiveFile, '{ not json', 'utf8')
    expect((await h.load()).archiveRead).toBe(false)
  })

  it('reads an archive written by this store after a restart', async () => {
    const h = harness()
    const store = await h.load()
    await store.put(record('old'))
    await store.archiveEnded(now, () => true)

    const reloaded = await h.load()

    expect(reloaded.get('old')).toBeNull()
    expect(reloaded.getAny('old')).toEqual(store.getAny('old'))
    expect(readFileSync(h.archiveFile, 'utf8')).not.toContain('\n')
  })
})
