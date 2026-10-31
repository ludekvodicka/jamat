import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionRecord } from './sessionRecord.types'
import { SessionRecordsStore } from './sessionRecordsStore'
import { SessionAccounts } from '../sessionAccounts'

describe('lib-orchestrator/sessionManager/records/sessionRecordsStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    file: string
    snapshotsDirectory: string
    reports: string[]
    load: () => Promise<SessionRecordsStore>
  }

  function harness(initial?: unknown): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-session-records-'))
    created.push(root)
    const file = join(root, 'session-records.json')
    if (initial !== undefined)
      writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial), 'utf8')
    const snapshotsDirectory = join(root, 'session-snapshots')
    const reports: string[] = []
    return {
      file,
      snapshotsDirectory,
      reports,
      load: () => SessionRecordsStore.load(file, {
        snapshotsDirectory,
        report: (message) => reports.push(message),
      }),
    }
  }

  function record(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId,
      kind: 'shell',
      title: sessionId,
      directory: { mode: 'default' },
      binding: null,
      life: 'starting',
      createdAt: 1,
      ...overrides,
    }
  }

  function snapshotCount(directory: string): number {
    return existsSync(directory) ? readdirSync(directory).length : 0
  }

  it('reads legacy agents as main without rewriting their stored shape', async () => {
    const legacy = record('legacy', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new' } })
    const h = harness()
    await (await h.load()).put(legacy)
    const restored = (await h.load()).get('legacy')!
    expect(SessionAccounts.ref(restored)).toEqual({ agentId: 'claude', accountId: 'main' })
    expect(SessionAccounts.launchRef(restored)).toEqual({ agentId: 'claude', accountId: 'main' })
    expect(SessionAccounts.segments(restored)).toEqual([{ accountId: 'main', from: 1, to: null }])
    expect(restored).toEqual(legacy)
  })

  it('preserves the launched account separately from a selected account across reload', async () => {
    const h = harness()
    const saved = record('switch', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new',
      accountId: 'b', launchAccountId: 'a' },
      accountSegments: [{ accountId: 'a', from: 1, to: 1 }, { accountId: 'b', from: 1, to: null }] })
    await (await h.load()).put(saved)
    const restored = (await h.load()).get('switch')!
    expect(restored).toEqual(saved)
    expect(SessionAccounts.launchRef(restored)).toEqual({ agentId: 'claude', accountId: 'a' })
    expect(SessionAccounts.ref(restored)).toEqual({ agentId: 'claude', accountId: 'b' })
  })

  it('keeps run history and log folders when an ended session retains its worktree', async () => {
    const h = harness()
    const removed: string[] = []
    const store = await SessionRecordsStore.load(h.file, { snapshotsDirectory: h.snapshotsDirectory,
      removeSessionLogs: async (id) => { removed.push(id) } })
    const worktree = { worktreePath: 'Q:/work', branch: 'https://svn.test/work', baseCommit: 'r1', repositoryRoot: 'Q:/main', kind: 'svn' as const }
    const scriptRuns: NonNullable<SessionRecord['scriptRuns']> = [{ runId: 'attempt', phase: 'after', scriptId: 'svn', name: 'commit', title: 'svn commit',
      commands: [], startedAt: 1, endedAt: 2, outcome: 'failed', log: { state: 'saved', bytes: 4, truncated: false } }]
    await store.put(record('a', { life: 'live', worktree, scriptRuns,
      worktreeLifecycle: { version: 0, actionId: null, phase: 'active', outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } } }))
    await store.put({ ...store.get('a')!, life: 'ended', completed: true, endedAt: 3 })
    expect(store.get('a')?.scriptRuns).toEqual(scriptRuns)
    await store.put({ ...store.get('a')!, life: 'starting', pendingOperationKind: 'reopen' }, { newLifetime: true })
    expect(store.get('a')?.scriptRuns).toEqual(scriptRuns)
    expect(removed).not.toContain('a')
  })

  it.each([null, '1', -1])('drops malformed agent start proof %s without losing the worktree', async (agentStartedAt) => {
    const worktree = { worktreePath: 'Q:/work', branch: 'https://svn.test/work', baseCommit: 'r1', repositoryRoot: 'Q:/main', kind: 'svn' }
    const h = harness({ schemaVersion: 1, records: [record('a', { worktree: { ...worktree, agentStartedAt } as unknown as SessionRecord['worktree'] })] })
    expect((await h.load()).get('a')?.worktree).toEqual(worktree)
    expect(h.reports.join(' ')).toContain('dropping malformed worktree agent start proof')
  })

  it('drops malformed setup hashes without losing the worktree', async () => {
    const worktree = { worktreePath: 'Q:/work', branch: 'https://svn.test/work', baseCommit: 'r1', repositoryRoot: 'Q:/main', kind: 'svn' }
    const it_ = harness({ schemaVersion: 1, records: [record('a', { worktree: { ...worktree, setupBaseline: { at: 1, hashes: { '../outside': 'hash' } } } as SessionRecord['worktree'] })] })
    expect((await it_.load()).get('a')?.worktree).toEqual(worktree)
    expect(it_.reports.join(' ')).toContain('dropping malformed worktree setup baseline')
  })

  it('drops malformed conflict memory without losing its worktree', async () => {
    const worktree = { worktreePath: 'Q:/work', branch: 'https://svn.test/work', baseCommit: 'r1', repositoryRoot: 'Q:/main', kind: 'svn' }
    const it_ = harness({ schemaVersion: 1, records: [record('a', { worktree: { ...worktree, conflictMemory: { paths: 'bad' } } as unknown as SessionRecord['worktree'] })] })
    const store = await it_.load()
    expect(store.get('a')?.worktree).toEqual(worktree)
    expect(it_.reports.join(' ')).toContain('dropping malformed worktree conflict memory')
  })

  it('preserves Git approval and completed logs, drops malformed additions, and closes interrupted command runs', async () => {
    const context = harness({ schemaVersion: 1, records: [
      record('pp-u11-approved', { worktreeMerge: { phase: 'base-merging', startedAt: 1,
        approval: { selection: ['Q:/work/a.txt'], message: 'Approved' },
        runs: [{ phase: 'commit', runId: 'commit-1', startedAt: 1, endedAt: 2 },
          { phase: 'base-merging', runId: 'base-1', startedAt: 2 }] } }),
      { ...record('pp-u11-malformed'), worktreeMerge: { phase: 'base-merging', startedAt: 1,
        approval: { selection: 9 }, runs: [null, { phase: 'future', runId: 8 }], changes: 'yes', endedAt: 'later', future: true } },
    ] })
    const store = await context.load()
    expect(store.get('pp-u11-approved')?.worktreeMerge).toMatchObject({
      approval: { selection: ['Q:/work/a.txt'], message: 'Approved' },
      failure: expect.stringContaining('interrupted'),
      runs: [{ phase: 'commit', runId: 'commit-1', startedAt: 1, endedAt: 2 },
        { phase: 'base-merging', runId: 'base-1', startedAt: 2, endedAt: expect.any(Number), failed: true }],
    })
    expect(store.get('pp-u11-malformed')?.worktreeMerge).toEqual({ phase: 'base-merging', startedAt: 1, runs: [], future: true })
  })

  it('quarantines legacy guessed Codex IDs while preserving the original for recovery', async () => {
    const context = harness({schemaVersion: 1, records: [
      record('old', {kind: 'agent', agent: {agentId: 'codex', launchMode: 'new', nativeSessionId: 'guessed'}}),
      record('explicit', {kind: 'agent', agent: {agentId: 'codex', launchMode: 'resume', nativeSessionId: 'selected'}}),
      record('proven', {kind: 'agent', agent: {agentId: 'codex', launchMode: 'fork', nativeSessionId: 'confirmed', nativeSessionIdSource: 'codex-app-server'}}),
    ]})
    const store = await context.load()
    expect(store.get('old')?.agent?.nativeSessionId).toBeUndefined()
    expect(store.get('old')?.agent?.unverifiedNativeSessionId).toBe('guessed')
    expect(store.get('explicit')?.agent).toMatchObject({nativeSessionId: 'selected', nativeSessionIdSource: 'provided'})
    expect(store.get('proven')?.agent?.nativeSessionId).toBe('confirmed')
    await store.put({...store.get('old')!, title: 'Kept'})
    expect((await context.load()).get('old')?.agent?.unverifiedNativeSessionId).toBe('guessed')
  })

  it('coalesces user input and persists the latest time without replacing concurrent record edits', async () => {
    const it_ = harness()
    const store = await it_.load()
    const original = record('a')
    await store.put(original)
    expect(store.lastUserInputAt('a')).toBeNull()
    store.noteUserInput('a', 100)
    store.noteUserInput('a', 200)
    store.noteUserInput('a', 150)
    expect(store.lastUserInputAt('a')).toBe(200)
    expect((await it_.load()).lastUserInputAt('a')).toBeNull()
    await Promise.all([store.flushUserInput(), store.put({ ...original, title: 'Renamed' })])
    const loaded = await it_.load()
    expect(loaded.get('a')).toMatchObject({ title: 'Renamed', lastUserInputAt: 200 })
    expect(snapshotCount(it_.snapshotsDirectory)).toBe(0)
    expect(it_.reports).toEqual([])
  })

  it('does not resurrect a removed record when queued user input is flushed', async () => {
    const it_ = harness()
    const store = await it_.load()
    await store.put(record('a'))
    store.noteUserInput('a', 100)
    const removing = store.remove('a')
    store.noteUserInput('a', 200)
    await removing
    store.noteUserInput('a', 300)
    await store.flushUserInput()
    expect(store.lastUserInputAt('a')).toBeNull()
    expect((await it_.load()).list()).toEqual([])
    expect(it_.reports).toEqual([])
  })

  describe('two writers at once', () => {
    /*
     * Every mutation is a read-modify-write with an await in the middle: a destructive commit takes
     * a recovery point first, which is a copyFile and a rotation. A write that computed its list
     * before that await and landed after it used to be silently reverted, in memory and on disk.
     * Nothing outside serialises them - the merge flow deliberately runs off the session manager's
     * operation queue so its git steps do not hold it, and `resumeMerge` is fired from inside a
     * reconcile pass without being awaited.
     */
    it('keeps a put that lands while a destructive write is taking its recovery point', async () => {
      const it_ = harness()
      const store = await it_.load()
      await store.put(record('a'))
      await store.put(record('b'))

      // `remove` is the destructive one, so it is the await the put has to survive.
      const [removed, added] = await Promise.all([
        store.remove('a'),
        store.put(record('c')),
      ])

      expect(removed).toBe(true)
      expect(added).toBe(true)
      expect(store.list().map((record) => record.sessionId).sort()).toEqual(['b', 'c'])
      const onDisk = JSON.parse(readFileSync(it_.file, 'utf8')) as { records: { sessionId: string }[] }
      expect(onDisk.records.map((record) => record.sessionId).sort()).toEqual(['b', 'c'])
    })

    // An update reads the record inside its turn, so a stale copy never undoes a write queued first.
    it('applies an update to the record as the writes before it left it', async () => {
      const it_ = harness()
      const store = await it_.load()
      await store.put(record('a'))

      const [noted, updated] = await Promise.all([
        store.put(record('a', { note: 'first' })),
        store.update('a', (current) => ({ ...current, title: 'second' })),
      ])

      expect([noted, updated]).toEqual([true, true])
      expect(store.get('a')).toEqual(expect.objectContaining({ note: 'first', title: 'second' }))
      expect(await store.update('a', () => null)).toBe(false)
      expect(await store.update('missing', (current) => current)).toBe(false)
      await expect(store.update('a', (current) => ({ ...current, sessionId: 'b' }))).rejects.toThrow('answered b')
      expect(snapshotCount(it_.snapshotsDirectory)).toBe(0)
    })

    it('writes a burst of puts in the order they were asked for, losing none', async () => {
      const it_ = harness()
      const store = await it_.load()

      await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => store.put(record(id))))

      expect(store.list().map((record) => record.sessionId).sort())
        .toEqual(['a', 'b', 'c', 'd', 'e'])
      const onDisk = JSON.parse(readFileSync(it_.file, 'utf8')) as { records: { sessionId: string }[] }
      expect(onDisk.records).toHaveLength(5)
    })
  })

  it('starts empty on a machine that has never had a session, without latching', async () => {
    const context = harness()
    const store = await context.load()
    expect(store.list()).toEqual([])
    expect(store.latched).toBe(false)
    expect(context.reports).toEqual([])
  })

  it('round-trips a document through put and a fresh load', async () => {
    const context = harness()
    const store = await context.load()
    expect(await store.put(record('a', { life: 'live', binding: { hostInstanceId: 'h1', generation: 2 } })))
      .toBe(true)
    const reloaded = await context.load()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.get('a')?.binding).toEqual({ hostInstanceId: 'h1', generation: 2 })
    expect(JSON.parse(readFileSync(context.file, 'utf8')).schemaVersion).toBe(1)
  })

  it('accepts old agent records without transcript provenance and round-trips an absolute one', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('old', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-old' },
      })],
    })
    const store = await context.load()

    expect(store.get('old')?.transcriptCwd).toBeUndefined()
    expect(await store.put(record('new', {
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'native-new' },
      transcriptCwd: join(context.snapshotsDirectory, 'original-worktree'),
    }))).toBe(true)
    expect((await context.load()).get('new')?.transcriptCwd)
      .toBe(join(context.snapshotsDirectory, 'original-worktree'))
  })

  it('refuses relative, empty and shell transcript provenance', async () => {
    const context = harness()
    const store = await context.load()
    const agent = {
      kind: 'agent' as const,
      agent: { agentId: 'claude' as const, launchMode: 'new' as const },
    }

    await expect(store.put(record('relative', { ...agent, transcriptCwd: 'relative/path' })))
      .rejects.toThrow('transcriptCwd must be a non-empty absolute path')
    await expect(store.put(record('empty', { ...agent, transcriptCwd: '' })))
      .rejects.toThrow('transcriptCwd must be a non-empty absolute path')
    await expect(store.put(record('shell', { transcriptCwd: context.snapshotsDirectory })))
      .rejects.toThrow('a shell record cannot carry transcriptCwd')
  })

  it('replaces a record with the same sessionId rather than adding a second one', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('a'))
    await store.put(record('a', { life: 'live' }))
    expect(store.list()).toHaveLength(1)
    expect(store.get('a')?.life).toBe('live')
  })

  // The ring is the only thing standing between a mistaken removal and a lost session, so it must
  // not be spent on the binding and status writes every reconcile tick produces.
  it('spends a recovery point on remove and adopt, never on put', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('a'))
    await store.put(record('a', { life: 'live' }))
    expect(snapshotCount(context.snapshotsDirectory)).toBe(0)

    await store.adopt(record('b', { life: 'live', binding: { hostInstanceId: 'h1', generation: 1 } }))
    expect(snapshotCount(context.snapshotsDirectory)).toBe(1)

    await store.remove('a')
    expect(snapshotCount(context.snapshotsDirectory)).toBe(2)
    expect(store.get('a')).toBeNull()
  })

  /**
   * The promise this class makes about a destructive write is that the previous file is kept FIRST,
   * and `adopt` calls that recovery point "how a mistaken adoption becomes undoable". The snapshot
   * swallowed every error inside its own try, so the write went ahead with the ring empty and the
   * caller was told `true` either way: the undo was simply not there when somebody needed it.
   */
  it('refuses a destructive write whose recovery point could not be taken', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('a'))
    // A FILE where the snapshots directory belongs: what a read-only profile or an antivirus hold
    // amounts to, and the one failure a test can produce on every platform.
    writeFileSync(context.snapshotsDirectory, 'not a directory', 'utf8')

    expect(await store.remove('a')).toBe(false)

    // `false` means the file was left as this write found it, so the record is still there.
    expect(store.get('a')).not.toBeNull()
    expect(context.reports.some((line) => line.includes('no recovery point'))).toBe(true)
    // And not latched by it: the read never failed, so the next write may well land.
    expect(store.latched).toBe(false)
  })

  it('removing a sessionId that is not there changes nothing and spends no recovery point', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('a'))
    expect(await store.remove('missing')).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(snapshotCount(context.snapshotsDirectory)).toBe(0)
  })

  it('keeps ten recovery points', async () => {
    const context = harness()
    const store = await context.load()
    for (let index = 0; index < 12; index += 1) {
      await store.put(record(`s${index}`))
      await store.remove(`s${index}`)
    }
    expect(snapshotCount(context.snapshotsDirectory)).toBe(10)
  })

  it('latches on a damaged file, refuses every write and says so exactly once', async () => {
    const context = harness('{ this is not json')
    const store = await context.load()
    expect(store.latched).toBe(true)
    expect(context.reports).toHaveLength(1)

    expect(await store.put(record('a'))).toBe(false)
    expect(await store.put(record('b'))).toBe(false)
    expect(await store.remove('a')).toBe(false)

    // Two reports in total: the unreadable file, and the refusal, said once for the session.
    expect(context.reports).toHaveLength(2)
    // The damaged file is the user's evidence of what went wrong; it stays exactly as it was.
    expect(readFileSync(context.file, 'utf8')).toBe('{ this is not json')
  })

  it('carries unknown fields through a read untouched', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [{ ...record('a'), futureField: 'keep me' }],
    })
    const store = await context.load()
    expect((store.list()[0] as unknown as { futureField: string }).futureField).toBe('keep me')
  })

  it('drops an unusable record aloud and keeps the rest', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('a'), { sessionId: '', kind: 'shell' }, record('b')],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['a', 'b'])
    expect(store.latched).toBe(false)
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain('dropping a record')
  })

  /**
   * The other field the details card writes, and the one that had neither a check on write nor a
   * filter on read - unlike `color` beside it, which has both. A record carrying a number loaded
   * without a word, `SessionInfo.note` was then a number typed `string`, and the card's first Save
   * called `.trim()` on it inside a click handler.
   */
  it('drops a record whose note is not a string', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('a', { note: 42 } as unknown as Partial<SessionRecord>), record('b')],
    })
    const store = await context.load()

    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('note must be a string')
  })

  describe('the fields a merge and a resolver persist', () => {
    /*
     * The one unchecked value in this file that had a throw waiting for it:
     * `SessionNodeState.mergeBadgeOf` ends in `throw new Error('Unknown merge phase')` inside a
     * `useMemo`, and nothing under `renderer/` catches it. A hand-edited document took the whole
     * React root down at render instead of being dropped aloud here at load.
     */
    it('refuses a merge phase that is not one of the four', async () => {
      const store = await harness().load()

      await expect(store.put(record('a', {
        worktreeMerge: { phase: 'half-merged', startedAt: 1 },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown merge phase/)
    })

    it('refuses a merge with no startedAt', async () => {
      const store = await harness().load()

      await expect(store.put(record('a', {
        worktreeMerge: { phase: 'resolving', startedAt: 'now' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/needs a startedAt number/)
    })

    /*
     * A record written before `operationId` was dropped still carries it. Unknown fields ride
     * through this store untouched, which is what makes removing a field from the type a change to
     * what is WRITTEN rather than a change to what can be read back.
     */
    it('takes a merge that still carries the field nothing reads any more', async () => {
      const store = await harness().load()

      expect(await store.put(record('a', {
        worktreeMerge: { phase: 'resolving', startedAt: 1, operationId: 'op-1' },
      } as unknown as Partial<SessionRecord>))).toBe(true)
    })

    it('refuses a resolver pointer that is not a session id', async () => {
      const store = await harness().load()

      await expect(store.put(record('a', {
        worktreeMerge: { phase: 'resolving', startedAt: 1, resolveSessionId: 7 },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/resolveSessionId must be/)
      await expect(store.put(record('a', {
        scriptOf: { sessionId: 42, phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/scriptOf sessionId must be a non-empty string/)
    })

    /** A session wrongly read as one-shot is one nothing ever reopens. */
    it('refuses a oneShot that is not literally true', async () => {
      const store = await harness().load()

      await expect(store.put(record('a', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', oneShot: 'yes' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/oneShot must be true or absent/)
    })

    /*
     * These four strings become a spawn's `cwd` and the target of `worktree remove --force`, which
     * is the furthest from this file a bad value in it can get.
     */
    it('refuses a worktree missing any of its four strings', async () => {
      const store = await harness().load()

      for (const field of ['worktreePath', 'branch', 'baseCommit', 'repositoryRoot']) {
        const worktree: Record<string, unknown> = {
          worktreePath: 'C:\\wt',
          branch: 'jamat/fix',
          baseCommit: 'abc',
          repositoryRoot: 'C:\\repo',
        }
        worktree[field] = undefined
        await expect(store.put(record('a', { worktree } as unknown as Partial<SessionRecord>)))
          .rejects.toThrow(new RegExp(`worktree needs a ${field} string`))
      }
    })

    it('drops a loaded record whose merge phase it does not know, keeping the others', async () => {
      const context = harness({
        schemaVersion: 1,
        savedAt: 5,
        records: [
          record('a', {
            worktreeMerge: { phase: 'half-merged', startedAt: 1 },
          } as unknown as Partial<SessionRecord>),
          record('b'),
        ],
      })
      const store = await context.load()

      expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
      expect(context.reports[0]).toContain('unknown merge phase')
    })

    it('keeps a merge that is shaped the way the flow writes one', async () => {
      const store = await harness().load()

      expect(await store.put(record('a', {
        worktreeMerge: {
          phase: 'resolving',
          startedAt: 1,
          resolveSessionId: 'r1',
          failure: 'the resolver ended with 1',
        },
        scriptOf: undefined,
      }))).toBe(true)
      expect(store.get('a')?.worktreeMerge?.phase).toBe('resolving')
    })
  })

  describe('the fields an SVN worktree and its finish persist', () => {
    const svnWorktree = {
      worktreePath: 'C:\\repo\\.worktrees\\014-fix',
      branch: 'https://svn.example.test/repos/app/trunk',
      baseCommit: 'r41',
      repositoryRoot: 'C:\\repo',
      kind: 'svn' as const,
      directoryId: '12:34:5678',
    }

    it.each([true, false])('migrates setup left pending on a removed worktree, agreement=%s (UA2-J01-01)', async (agreement) => {
      const pendingSetup = { setupSessionId: 'setup-1', ...agreement ? { agreement: { hash: 'setup-hash', commands: ['node setup.js'] } } : {} }
      const endedReason = agreement ? 'Setup waits for command approval' : 'Setup failed with exit 3'
      const retiredWorktree = { kind: 'svn' as const, worktreePath: svnWorktree.worktreePath, revisions: [], removedAt: 8, ownerDir: svnWorktree.repositoryRoot }
      const context = harness({ schemaVersion: 1, savedAt: 9, records: [
        record('removed', { life: 'ended', pendingSetup, endedReason, retiredWorktree, completed: true }),
        record('waiting', { life: 'ended', pendingSetup, endedReason, worktree: svnWorktree }),
        record('local', { life: 'ended', pendingSetup, endedReason }),
      ] })
      const store = await context.load()
      expect(store.get('removed')?.pendingSetup).toBeUndefined()
      expect(store.get('removed')?.endedReason).toBe(agreement ? 'Setup cancelled; worktree removed' : endedReason)
      expect(store.get('removed')?.stopRequested).toBe(agreement ? true : undefined)
      expect(store.get('waiting')?.pendingSetup).toEqual(pendingSetup)
      expect(store.get('local')?.pendingSetup).toEqual(pendingSetup)
      const saved = JSON.parse(readFileSync(context.file, 'utf8')).records.find((entry: SessionRecord) => entry.sessionId === 'removed')
      expect(saved.pendingSetup).toBeUndefined()
      expect((await context.load()).get('removed')?.retiredWorktree).toEqual(retiredWorktree)
      expect(context.reports).toEqual([])
    })

    it('round-trips an SVN worktree, its outcome and a tombstone through a fresh load', async () => {
      const context = harness()
      const store = await context.load()
      const outcome = {
        result: 'committed' as const,
        revisions: ['https://svn.example.test/repos/app:r42'],
        main: 'merged:1' as const,
        worktree: 'kept' as const,
        lines: ['MAIN MERGED src/a.ts'],
        at: 9,
      }
      const tombstone = {
        worktreePath: 'C:\\repo\\.worktrees\\013-old',
        kind: 'svn' as const,
        revisions: ['https://svn.example.test/repos/app:r40'],
        removedAt: 8,
      }

      expect(await store.put(record('a', { worktree: svnWorktree, worktreeOutcome: outcome }))).toBe(true)
      expect(await store.put(record('b', { retiredWorktree: tombstone, completed: true }))).toBe(true)

      const reloaded = await context.load()
      expect(reloaded.get('a')?.worktree).toEqual(svnWorktree)
      expect(reloaded.get('a')?.worktreeOutcome).toEqual(outcome)
      expect(reloaded.get('b')?.retiredWorktree).toEqual(tombstone)
      expect(context.reports).toEqual([])
    })

    // A launch joins it onto the worktree path, so a place that climbs out of the worktree is no place.
    it('round-trips the place of a session below its owner and refuses one that leaves the worktree', async () => {
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { worktree: { ...svnWorktree, cwdSubpath: 'Member/src' } }),
        record('b', { worktree: { ...svnWorktree, cwdSubpath: '../other' } }),
        record('c', { worktree: { ...svnWorktree, cwdSubpath: 'C:\\elsewhere' } }),
      ] })
      const store = await context.load()

      expect(store.list().map((entry) => entry.sessionId)).toEqual(['a'])
      expect(store.get('a')?.worktree?.cwdSubpath).toBe('Member/src')
      expect(context.reports.join(' | ')).toContain('worktree cwdSubpath must be a relative path')
      for (const cwdSubpath of ['', '/abs', 'a//b', './a'])
        await expect(store.put(record('d', { worktree: { ...svnWorktree, cwdSubpath } }))).rejects.toThrow(/cwdSubpath/)
    })

    // Every launch inside the worktree carries them, so a name that is not one, or is Jamat's own, is refused.
    it('round-trips the variables of a worktree setup and refuses a name a launch must not carry', async () => {
      const variables = { pnpm_config_enable_global_virtual_store: 'true' }
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { worktree: { ...svnWorktree, setupVariables: variables } }),
        record('b', { worktree: { ...svnWorktree, setupVariables: { JAMAT_V3_SESSION_ID: 'x' } } }),
        record('c', { worktree: { ...svnWorktree, setupVariables: { 'a=b': 'x' } } }),
      ] })
      const store = await context.load()

      expect(store.list().map((entry) => entry.sessionId)).toEqual(['a'])
      expect(store.get('a')?.worktree?.setupVariables).toEqual(variables)
      expect(context.reports.join(' | ')).toContain('worktree setupVariables must map variable names to strings')
      await expect(store.put(record('d', { worktree: { ...svnWorktree, setupVariables: { name: 1 } as never } })))
        .rejects.toThrow(/setupVariables/)
    })

    it('reads a worktree without a kind, which every older record is', async () => {
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', {
        worktree: { worktreePath: 'C:\\wt', branch: 'jamat/fix', baseCommit: 'abc', repositoryRoot: 'C:\\repo' },
      })] })

      const store = await context.load()

      expect(store.get('a')?.worktree?.kind).toBeUndefined()
      expect(context.reports).toEqual([])
    })

    it('refuses a worktree kind it does not know, in both directions', async () => {
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { worktree: { ...svnWorktree, kind: 'hg' } } as unknown as Partial<SessionRecord>),
        record('b'),
      ] })
      const store = await context.load()

      expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
      expect(context.reports[0]).toContain('unknown worktree kind')
      await expect(store.put(record('c', {
        worktree: { ...svnWorktree, kind: 'hg' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown worktree kind/)
      await expect(store.put(record('c', {
        retiredWorktree: { worktreePath: 'C:\\wt', kind: 'hg', revisions: [], removedAt: 1 },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown retired worktree kind/)
    })

    it('refuses a finish phase, result or main answer that is not in its closed set', async () => {
      const store = await harness().load()
      const outcome = { result: 'committed', revisions: [], main: 'none', worktree: 'kept', lines: [], at: 1 }

      await expect(store.put(record('a', {
        worktree: svnWorktree, worktreeFinish: { phase: 'merging', startedAt: 1 },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown finish phase/)
      await expect(store.put(record('a', {
        worktreeOutcome: { ...outcome, result: 'done' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown finish result/)
      await expect(store.put(record('a', {
        worktreeOutcome: { ...outcome, main: 'merged:x' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown finish main result/)
      await expect(store.put(record('a', {
        worktreeOutcome: { ...outcome, revisions: [42] },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/revisions must be a list of strings/)
    })

    it('round-trips a cleanup, and keeps it pending across a load', async () => {
      const context = harness()
      const store = await context.load()
      const cleanup = {
        phase: 'pending' as const,
        trigger: 'committed' as const,
        reason: 'unlanded r12: src/a.ts',
        requestedAt: 4,
        attempts: 2,
        lastAttemptAt: 6,
      }

      expect(await store.put(record('a', { life: 'ended', worktree: svnWorktree, worktreeCleanup: cleanup }))).toBe(true)

      expect((await context.load()).get('a')?.worktreeCleanup).toEqual(cleanup)
      expect(context.reports).toEqual([])
    })

    it('refuses a cleanup phase, trigger or count that is not its own', async () => {
      const store = await harness().load()
      const cleanup = { phase: 'pending', trigger: 'committed', requestedAt: 1, attempts: 0 }

      await expect(store.put(record('a', {
        worktree: svnWorktree, worktreeCleanup: { ...cleanup, phase: 'waiting' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown cleanup phase/)
      await expect(store.put(record('a', {
        worktree: svnWorktree, worktreeCleanup: { ...cleanup, trigger: 'stopped' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/unknown cleanup trigger/)
      await expect(store.put(record('a', {
        worktree: svnWorktree, worktreeCleanup: { ...cleanup, attempts: -1 },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/attempts count/)
      await expect(store.put(record('a', {
        worktree: svnWorktree, worktreeCleanup: { ...cleanup, lastAttemptAt: 'now' },
      } as unknown as Partial<SessionRecord>))).rejects.toThrow(/lastAttemptAt/)
    })

    it('loads a record holding a finish as an interrupted outcome naming the phase, and writes it back', async () => {
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', {
        life: 'ended',
        worktree: svnWorktree,
        worktreeFinish: { phase: 'main-updating', scopeRoot: 'C:\\repo\\.worktrees\\014-fix', startedAt: 3 },
      })] })

      const store = await context.load()

      const loaded = store.get('a')
      expect(loaded?.worktreeFinish).toBeUndefined()
      expect(loaded?.worktree).toEqual(svnWorktree)
      expect(loaded?.worktreeOutcome).toMatchObject({
        result: 'interrupted', revisions: [], main: 'none', worktree: 'kept',
        lines: ['INTERRUPTED during main-updating in C:\\repo\\.worktrees\\014-fix'],
      })
      const onDisk = JSON.parse(readFileSync(context.file, 'utf8')) as { records: SessionRecord[] }
      expect(onDisk.records[0]?.worktreeFinish).toBeUndefined()
      expect(onDisk.records[0]?.worktreeOutcome?.result).toBe('interrupted')
    })

    it('keeps the revisions of the earlier outcome in an interrupted one', async () => {
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', {
        life: 'ended',
        worktree: svnWorktree,
        worktreeOutcome: { result: 'committed', revisions: ['https://svn/repo:r12'], main: 'updated', worktree: 'in-use', lines: [], at: 2 },
        worktreeFinish: { phase: 'updating', startedAt: 3 },
      })] })

      const store = await context.load()

      expect(store.get('a')?.worktreeOutcome).toMatchObject({ result: 'interrupted', revisions: ['https://svn/repo:r12'] })
    })

    const action = {
      kind: 'finish' as const, flowVersion: 1 as const, actionId: 'act-1', stage: 'checks' as const, runId: 'run-1',
      root: 'C:\\repo\\.worktrees\\014-fix', checks: [], checkCursor: 0, rootCursor: 0,
      roots: [{ path: 'C:\\repo\\.worktrees\\014-fix', own: '', changed: ['a.txt'] }],
      rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      evidence: [{ repository: 'https://svn/repo', revision: 12, label: 'receipt' as const }],
      requestedBy: 'window' as const, startedAt: 4,
    }

    it('loads a waiting main-update with its Finish history unchanged under schema version 1', async () => {
      const waiting = { ...action, stage: 'main-update' as const, runId: undefined,
        passes: [{ stage: 'removing' as const, startedAt: 4, endedAt: 5, result: 'done' as const }] }
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', { life: 'ended', svnAction: waiting,
        retiredWorktree: { worktreePath: action.root, kind: 'svn', revisions: [], removedAt: 5, ownerDir: 'C:/repo', landed: action.evidence },
      })] })
      expect((await context.load()).get('a')?.svnAction).toEqual(waiting)
    })

    it.each(['stopping', 'evidence', 'checks', 'updating', 'cleaning', 'resolving', 'merging', 'verifying', 'fixing', 'diffing', 'reviewing', 'removing', 'recording'] as const)(
      'migrates a 3.13 Finish at %s to Changes and persists it without its old run pointer', async (stage) => {
        const conflictSet = { readAt: 5, baseRevision: 1, revision: 2, entries: [], more: 0 }
        const legacy = { ...action, flowVersion: undefined, stage, conflictSet, reviewCommitId: 'dialog-1', retryAt: 10,
          verdict: { kind: 'succeeded' as const }, needs: { kind: 'conflict' as const, reason: 'needs review', at: 5 } }
        const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', { life: 'ended', worktree: svnWorktree, svnAction: legacy })] })
        const store = await context.load()
        const migrated = store.get('a')?.svnAction
        expect(migrated).toMatchObject({ flowVersion: 1, stage: 'changes', evidence: action.evidence, conflictSet })
        for (const field of ['runId', 'verdict', 'retryAt', 'needs', 'merger', 'commit'] as const)
          expect(migrated?.[field]).toBeUndefined()
        expect(migrated).not.toHaveProperty('reviewCommitId')
        expect(store.get('a')?.worktree).toEqual(svnWorktree)
        expect(JSON.parse(readFileSync(context.file, 'utf8')).records[0].svnAction).toEqual(migrated)
      },
    )

    it.each(['discard', 'update-main'] as const)('keeps a 3.13 %s action unchanged', async (kind) => {
      const legacy = { ...action, flowVersion: undefined, kind, stage: 'updating' as const }
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', { life: 'ended', worktree: svnWorktree, svnAction: legacy })] })
      expect((await context.load()).get('a')?.svnAction).toEqual(legacy)
    })

    // A running action continues from the record and the disk after a restart, unlike a 3.10 finish.
    it('loads an SVN action as it stands and never reads it as interrupted', async () => {
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', { life: 'ended', worktree: svnWorktree, svnAction: action })] })

      const store = await context.load()

      expect(store.get('a')?.svnAction).toEqual(action)
      expect(store.get('a')?.worktreeOutcome).toBeUndefined()
      expect(context.reports).toEqual([])
    })

    it('drops an SVN action it cannot read aloud and keeps the session with its worktree', async () => {
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a', {
        life: 'ended', worktree: svnWorktree, svnAction: { ...action, stage: 'landing' as 'reviewing' },
      })] })

      const store = await context.load()

      expect(store.get('a')?.svnAction).toBeUndefined()
      expect(store.get('a')?.worktree).toEqual(svnWorktree)
      expect(context.reports.some((line) => line.includes('Unreadable SVN action (unknown SVN action stage "landing")'))).toBe(true)
    })

    it('loads a resolving action with its conflicts and its resolver in accept-edits mode, and drops a malformed one', async () => {
      const resolving = { ...action, stage: 'resolving' as const, conflicts: { paths: ['a.txt'], before: ['a.txt', 'b.txt'], at: 6 }, resolverSpent: true as const }
      const resolver = record('r', {
        kind: 'agent', agent: { agentId: 'claude', launchMode: 'fork', forkParentId: 'n1', oneShot: true, permission: 'accept-edits' },
        scriptOf: { sessionId: 'a', phase: 'after', scriptId: 'svn-resolve', name: 'resolver' },
      })
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { life: 'ended', worktree: svnWorktree, svnAction: resolving }),
        resolver,
        record('b', { life: 'ended', worktree: svnWorktree, svnAction: { ...resolving, conflicts: { paths: 'a.txt', before: [], at: 6 } } as never }),
      ] })

      const store = await context.load()

      expect(store.get('a')?.svnAction).toEqual(resolving)
      expect(store.get('r')).toEqual(resolver)
      expect(store.get('b')?.svnAction).toBeUndefined()
      await expect(store.put(record('c', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new', permission: 'yolo' } } as unknown as Partial<SessionRecord>)))
        .rejects.toThrow(/unknown agent permission "yolo"/)
    })

    it('loads a landed row with its UPDATE in the diff stage, beside a 3.10 tombstone without an owner, and refuses landed revisions without one', async () => {
      const landed = {
        worktreePath: 'C:\\repo\\.worktrees\\014-fix', kind: 'svn' as const, revisions: ['https://svn/repo:r12'], removedAt: 8,
        ownerDir: 'C:\\repo', landed: [{ repository: 'https://svn/repo', revision: 12, label: 'receipt' as const }],
      }
      const update = {
        ...action, kind: 'update-main' as const, stage: 'diffing' as const, root: 'C:\\repo', roots: undefined, evidence: [],
        conflicts: { paths: ['a.txt'], before: ['a.txt'], at: 6 }, resolverSpent: true as const,
      }
      const older = { worktreePath: 'C:\\repo\\.worktrees\\013-old', kind: 'svn' as const, revisions: [], removedAt: 3 }
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { life: 'ended', retiredWorktree: landed, svnAction: update }),
        record('b', { life: 'ended', retiredWorktree: older, completed: true }),
      ] })

      const store = await context.load()

      expect(store.get('a')?.retiredWorktree).toEqual(landed)
      expect(store.get('a')?.svnAction).toEqual(update)
      expect(store.get('b')?.retiredWorktree).toEqual(older)
      expect(context.reports).toEqual([])
      await expect(store.put(record('c', { retiredWorktree: { ...landed, ownerDir: undefined } })))
        .rejects.toThrow(/retiredWorktree landed must be a list of labelled revisions beside an ownerDir/)
    })

    it('loads an action at fixing with its conflict set, and drops a set it cannot word while the action stays', async () => {
      const entry = { path: '.aidocs/engines', kind: 'tree' as const, shape: 'obstructed-dir' as const, state: 'settled' as const,
        options: ['keep-both' as const], facts: { incomingRevision: 2 }, by: 'person' as const, settledWith: 'keep-both' as const,
        journal: { option: 'keep-both' as const, done: 5 }, saved: 'C:\\results\\act-1\\saved\\.aidocs\\engines' }
      const fixing = { ...action, stage: 'fixing' as const, conflictSet: { readAt: 5, baseRevision: 1, revision: 2, entries: [entry], more: 0 } }
      const newer = { ...fixing, conflictSet: { ...fixing.conflictSet, entries: [{ ...entry, shape: 'moved-twice' }] } }
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { life: 'ended', worktree: svnWorktree, svnAction: fixing }),
        record('b', { life: 'ended', worktree: svnWorktree, svnAction: newer as never }),
      ] })

      const store = await context.load()

      expect(store.get('a')?.svnAction).toEqual(fixing)
      expect(store.get('b')?.svnAction).toEqual({ ...action, stage: 'fixing' })
      expect(context.reports.some((line) => line.includes('dropping the conflict set of its SVN action'))).toBe(true)
    })

    it('keeps what Jamat fixed and a waited set, and drops a list of fixes it cannot word while the action stays', async () => {
      const fixed = { ...action, stage: 'fixing' as const, fixed: [{ path: '.aidocs/engines', option: 'keep-both' as const }],
        conflictSet: { readAt: 5, baseRevision: 1, revision: 2, entries: [], more: 1, waited: true as const } }
      const newer = { ...action, fixed: [{ path: 'a', option: 'rebase' }] }
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { life: 'ended', worktree: svnWorktree, svnAction: fixed }),
        record('b', { life: 'ended', worktree: svnWorktree, svnAction: newer as never }),
      ] })

      const store = await context.load()

      expect(store.get('a')?.svnAction).toEqual(fixed)
      expect(store.get('b')?.svnAction).toEqual(action)
      expect(context.reports.some((line) => line.includes('dropping the fixes of its SVN action'))).toBe(true)
    })

    it('keeps an action at merging with its merger, and drops a merger it cannot read while the action stays', async () => {
      const merging = { ...action, stage: 'merging' as const, runId: 'm1', merger: { runId: 'm1', setAt: 5, startedAt: 6, endedAt: 7, checkedAt: 8 },
        mergeBrief: 'L:/logs/a/x-merge.md' }
      const broken = { ...action, stage: 'merging' as const, runId: 'm2', merger: { runId: 'm2', setAt: 'later', startedAt: 6 } }
      const context = harness({ schemaVersion: 1, savedAt: 5, records: [
        record('a', { life: 'ended', worktree: svnWorktree, svnAction: merging }),
        record('b', { life: 'ended', worktree: svnWorktree, svnAction: broken as never }),
      ] })

      const store = await context.load()

      expect(store.get('a')?.svnAction).toEqual(merging)
      expect(store.get('b')?.svnAction).toEqual({ ...action, stage: 'merging', runId: 'm2' })
      expect(context.reports.some((line) => line.includes('dropping the merger of its SVN action'))).toBe(true)
    })

    it('refuses to write an SVN action whose checks are not checks', async () => {
      const store = await harness().load()
      const declared = { key: 'k', scriptId: 'declared' as const, name: 'tests', commands: [{ command: 'pnpm test', cwd: 'C:\\repo' }] }

      await expect(store.put(record('a', { worktree: svnWorktree, svnAction: { ...action, checks: [declared] } })))
        .rejects.toThrow(/svnAction checks: a "declared" step is not a check/)
    })
  })

  it('drops a duplicate sessionId, keeping the first', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('a', { title: 'first' }), record('a', { title: 'second' })],
    })
    const store = await context.load()
    expect(store.list()).toHaveLength(1)
    expect(store.get('a')?.title).toBe('first')
  })

  it('treats an unsupported schema version as damage rather than guessing', async () => {
    const context = harness({ schemaVersion: 2, savedAt: 5, records: [] })
    const store = await context.load()
    expect(store.latched).toBe(true)
  })

  // Records come from this library's own code, so an invalid one is a defect here, not user input:
  // it fails loudly at the call site instead of being coerced into the file.
  it('throws when asked to store an invalid record', async () => {
    const context = harness()
    const store = await context.load()
    await expect(store.put(record('a', { kind: 'agent' }))).rejects.toThrow(/needs an agent/)
    await expect(store.put({ ...record('a'), life: 'nonsense' as SessionRecord['life'] }))
      .rejects.toThrow(/unknown life/)
    expect(store.list()).toEqual([])
  })

  // Absence is the answer: a session nobody has finished with. Storing `false` would be a second
  // way to say nothing, and two ways is how a reader starts guessing.
  it('takes completed only in the shapes that mean something', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('b', { completed: true }))
    await store.put(record('c'))
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b', 'c'])
    await expect(store.put({
      ...record('d'),
      completed: false as unknown as SessionRecord['completed'],
    })).rejects.toThrow(/completed must be true or absent/)
    expect(store.get('d')).toBeNull()
  })

  // Set at create and never changed: a reload gives back the same link, and a 3.12 file has none.
  it('round-trips a parent link and refuses a kind or a session id it does not know', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('child', { parent: { sessionId: 'p', kind: 'worktree' } }))
    await store.put(record('plain'))

    const reloaded = await context.load()
    expect(reloaded.get('child')).toEqual(record('child', { parent: { sessionId: 'p', kind: 'worktree' } }))
    expect(Object.hasOwn(reloaded.get('plain') ?? {}, 'parent')).toBe(false)
    await expect(store.put(record('a', {
      parent: { sessionId: 'p', kind: 'unit' },
    } as unknown as Partial<SessionRecord>))).rejects.toThrow(/record a: unknown parent kind "unit"/)
    await expect(store.put(record('a', {
      parent: { sessionId: '', kind: 'ticket' },
    }))).rejects.toThrow(/parent sessionId must be a non-empty string/)
    await expect(store.put(record('a', { parent: 'p' } as unknown as Partial<SessionRecord>)))
      .rejects.toThrow(/parent must be an object/)
    expect(context.reports).toEqual([])
  })

  // A file of an older build carries no id and loads unchanged; a later write keeps the id through a reload.
  it('round-trips the control operation id of a create and refuses one that is empty or not a string', async () => {
    const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('old')] })
    const store = await context.load()
    expect(store.get('old')).toEqual(record('old'))
    await store.put(record('created', { callerOperationId: 'op-1' }))

    const reloaded = await context.load()
    expect(reloaded.get('created')?.callerOperationId).toBe('op-1')
    expect(reloaded.get('old')).toEqual(record('old'))
    await expect(store.put(record('a', { callerOperationId: '' })))
      .rejects.toThrow(/record a: callerOperationId must be a non-empty string/)
    await expect(store.put(record('a', { callerOperationId: 7 } as unknown as Partial<SessionRecord>)))
      .rejects.toThrow(/record a: callerOperationId must be a non-empty string/)
    expect(store.get('a')).toBeNull()
    expect(context.reports).toEqual([])
  })

  it('drops a loaded record whose control operation id is not a string, aloud and by its id', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('a', { callerOperationId: 42 } as unknown as Partial<SessionRecord>), record('b')],
    })
    const store = await context.load()

    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('record a: callerOperationId must be a non-empty string')
  })

  /**
   * The migration of 2026-09-23. `presentation: "tab"` said a session was drawn by its tab alone,
   * and nothing draws sessions that way any more, so a record that still carries it is an ordinary
   * session of the tree. It is dropped on READ rather than left to ride through, which is what
   * takes it out of the file the next time anything is written.
   */
  it('drops the retired presentation field out of a record it reads', async () => {
    const context = harness({
      schemaVersion: 1,
      records: [{ ...record('a'), presentation: 'tab' }, record('b')],
    })
    const store = await context.load()

    expect(store.list().map((entry) => entry.sessionId)).toEqual(['a', 'b'])
    expect(store.list().every((entry) => !Object.hasOwn(entry, 'presentation'))).toBe(true)
    expect(context.reports).toEqual([])
  })

  /**
   * The migration of 2026-10-07. A setup run said `setupFor` and a resolver `resolveFor`; both are
   * now the one `scriptOf` link, migrated on read, and the next write of any record leaves the old
   * names out of the file.
   */
  describe('the script link migration', () => {
    it('reads an old setupFor as a before setup link and writes it back without the old name', async () => {
      const context = harness({
        schemaVersion: 1,
        records: [{ ...record('setup'), setupFor: 'primary' }, record('other')],
      })
      const store = await context.load()

      expect(store.get('setup')?.scriptOf)
        .toEqual({ sessionId: 'primary', phase: 'before', scriptId: 'setup', name: 'setup' })
      expect(Object.hasOwn(store.get('setup') ?? {}, 'setupFor')).toBe(false)
      expect(await store.put(record('other', { title: 'Renamed' }))).toBe(true)
      const written = readFileSync(context.file, 'utf8')
      expect(written).not.toContain('setupFor')
      expect(JSON.parse(written).records[0].scriptOf)
        .toEqual({ sessionId: 'primary', phase: 'before', scriptId: 'setup', name: 'setup' })
      expect(context.reports).toEqual([])
    })

    it('reads an old resolveFor as an after merge-resolve link', async () => {
      const context = harness({
        schemaVersion: 1,
        records: [{
          ...record('resolver', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'fork', oneShot: true } }),
          resolveFor: 'merging',
        }],
      })
      const store = await context.load()

      expect(store.get('resolver')?.scriptOf)
        .toEqual({ sessionId: 'merging', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' })
      expect(Object.hasOwn(store.get('resolver') ?? {}, 'resolveFor')).toBe(false)
    })

    it('drops a record whose script link it cannot read, aloud, and keeps the others', async () => {
      const context = harness({
        schemaVersion: 1,
        records: [
          record('a', {
            scriptOf: { sessionId: 'p', phase: 'during', scriptId: 'setup', name: 'setup' },
          } as unknown as Partial<SessionRecord>),
          record('b', {
            scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'mystery', name: 'setup' },
          } as unknown as Partial<SessionRecord>),
          record('b2', {
            scriptOf: { sessionId: 'p', phase: 'inner', scriptId: 'setup', name: 'setup' },
          }),
          record('c', {
            scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'setup' },
          } as unknown as Partial<SessionRecord>),
          record('d', { scriptOf: 'p' } as unknown as Partial<SessionRecord>),
          record('e'),
        ],
      })
      const store = await context.load()

      expect(store.list().map((entry) => entry.sessionId)).toEqual(['e'])
      expect(context.reports).toHaveLength(5)
      expect(context.reports[0]).toContain('unknown script phase')
      expect(context.reports[1]).toContain('unknown script "mystery"')
      expect(context.reports[2]).toContain('unknown script "inner/setup"')
      expect(context.reports[3]).toContain('scriptOf needs a name string')
      expect(context.reports[4]).toContain('scriptOf must be an object')
    })
  })

  /**
   * A parent's history: read by the snapshot, so a shape this build cannot word is dropped aloud. The
   * entry goes, never the session with its worktree pointer and its gates.
   */
  it('keeps a script history in the shape it is written in, and drops only the entries it cannot read', async () => {
    const entry: NonNullable<SessionRecord['scriptRuns']>[number] = {
      runId: 'r1',
      phase: 'before',
      scriptId: 'setup',
      name: 'setup',
      title: 'Setup fix',
      commands: ['pnpm install'],
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      outcome: 'succeeded',
      log: { state: 'saved', bytes: 10, truncated: false },
    }
    const context = harness({
      schemaVersion: 1,
      records: [
        record('a', { scriptRuns: [entry, { ...entry, runId: 'r2', outcome: 'lost', log: { state: 'unavailable', reason: 'gone' } }] }),
        record('b', {
          worktree: { worktreePath: '/w/fix', branch: 'fix', baseCommit: 'abc', repositoryRoot: '/w' },
          scriptRuns: [{ ...entry, outcome: 'crashed' }, { ...entry, runId: 'r3' }, { ...entry, runId: 'r4', phase: 'later' }],
        } as unknown as Partial<SessionRecord>),
        record('c', { scriptRuns: [{ ...entry, log: { state: 'saved', bytes: 10 } }] } as unknown as Partial<SessionRecord>),
        record('d', { scriptRuns: [{ ...entry, phase: 'inner' }] } as unknown as Partial<SessionRecord>),
        record('e', { scriptRuns: entry } as unknown as Partial<SessionRecord>),
      ],
    })
    const store = await context.load()

    expect(store.list().map((candidate) => candidate.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(store.get('a')?.scriptRuns).toHaveLength(2)
    expect(store.get('b')?.scriptRuns?.map((kept) => kept.runId)).toEqual(['r3'])
    expect(store.get('b')?.worktree?.worktreePath).toBe('/w/fix')
    expect(store.get('c')?.scriptRuns).toEqual([])
    expect(store.get('e')?.scriptRuns).toBeUndefined()
    expect(context.reports).toEqual([
      expect.stringMatching(/record "b": dropping 2 script history entries it cannot read \(unknown run outcome "crashed"\)$/),
      expect.stringMatching(/record "c": dropping 1 script history entries it cannot read \(a saved log needs a bytes count/),
      expect.stringMatching(/record "d": dropping 1 script history entries it cannot read \(unknown script "inner\/setup"\)$/),
      expect.stringMatching(/record "e": dropping its script history \(scriptRuns must be an array\)$/),
    ])
    await expect(store.put(record('f', { scriptRuns: [{ ...entry, commands: [1] }] } as unknown as Partial<SessionRecord>)))
      .rejects.toThrow(/list of commands/)
  })

  it('keeps commit receipts as written, and drops aloud only the receipts it cannot read', async () => {
    const receipt: NonNullable<SessionRecord['commitReceipts']>[number] = { scopeRoot: '/w/fix', revision: 12, paths: ['a.txt'], at: 5 }
    const context = harness({
      schemaVersion: 1,
      records: [
        record('a', { commitReceipts: [receipt, { ...receipt, revision: null, paths: [] }] }),
        record('b', { commitReceipts: [{ ...receipt, revision: '12' }, { ...receipt, revision: 13 }] } as unknown as Partial<SessionRecord>),
        record('c', { commitReceipts: receipt } as unknown as Partial<SessionRecord>),
      ],
    })
    const store = await context.load()

    expect(store.list().map((candidate) => candidate.sessionId)).toEqual(['a', 'b', 'c'])
    expect(store.get('a')?.commitReceipts).toEqual([receipt, { ...receipt, revision: null, paths: [] }])
    expect(store.get('b')?.commitReceipts).toEqual([{ ...receipt, revision: 13 }])
    expect(store.get('c')?.commitReceipts).toBeUndefined()
    expect(context.reports).toEqual([
      expect.stringMatching(/record "b": dropping 1 commit receipts it cannot read \(a receipt revision must be a positive integer or null\)$/),
      expect.stringMatching(/record "c": dropping its commit receipts \(commitReceipts must be an array\)$/),
    ])
    await expect(store.put(record('d', { commitReceipts: [{ ...receipt, paths: [1] }] } as unknown as Partial<SessionRecord>)))
      .rejects.toThrow(/list of paths/)
  })

  it('removes several records in one write, and spends a recovery point only when asked to', async () => {
    const context = harness()
    const store = await context.load()
    for (const id of ['a', 'b', 'c']) await store.put(record(id))

    expect(await store.remove(['a', 'b'], { recoveryPoint: false })).toBe(true)
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['c'])
    expect(snapshotCount(context.snapshotsDirectory)).toBe(0)
    expect(await store.remove('c')).toBe(true)
    expect(snapshotCount(context.snapshotsDirectory)).toBe(1)
  })

  /**
   * The two witnesses of an ending. Both are optional and neither bumps the schema, so a file written
   * by a build that had never heard of them loads unchanged - what the reader gets back is a record
   * with no witness, which is exactly what it is.
   */
  it('takes the ending witnesses only in the shapes that mean something', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('a', { stopRequested: true, exitReason: 'stopped' }))
    await store.put(record('b'))
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['a', 'b'])
    await expect(store.put({
      ...record('d'),
      stopRequested: false as unknown as SessionRecord['stopRequested'],
    })).rejects.toThrow(/stopRequested must be true or absent/)
    expect(store.get('d')).toBeNull()
  })

  /**
   * `exitReason` is the Host's word rather than this library's, and a Host that outlives a client
   * across an upgrade is the normal state here. A reason a newer one invented must not cost anybody
   * the record it is written on - the record still names a worktree and a branch - so it rides
   * through like any other unknown field and the ending is read from the rest.
   */
  it('keeps a record carrying an ending reason it has never heard of', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('a', { exitReason: 'replaced' as SessionRecord['exitReason'] })],
    })
    const store = await context.load()

    expect(store.get('a')?.sessionId).toBe('a')
    expect(context.reports).toEqual([])
  })

  // An agent record that cannot say how it was started cannot be relaunched: reopening it would
  // either resume a conversation that never existed or start a second one under an id its agent
  // already holds. The field is required, and a record without it is dropped the way any other
  // unusable one is - aloud, and on its own.
  it('needs an agent record to say how it was launched', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        record('a', { kind: 'agent', agent: { agentId: 'claude' } as SessionRecord['agent'] }),
        record('b', {
          kind: 'agent',
          agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'n1' },
        }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(store.latched).toBe(false)
    expect(context.reports[0]).toContain('unknown launch mode')

    await expect(store.put(record('c', {
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'later' } as unknown as SessionRecord['agent'],
    }))).rejects.toThrow(/unknown launch mode/)
    expect(store.get('b')?.agent?.launchMode).toBe('new')
  })

  // The kind is what the reconciler builds the replayed command line from, so a value it cannot read
  // is refused on the way in and dropped on the way out, exactly like the launch mode.
  it('needs a pending operation kind it knows, when there is one at all', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        record('a', {
          life: 'starting',
          pendingOperationId: 'op-1',
          pendingOperationKind: 'relaunch' as SessionRecord['pendingOperationKind'],
        }),
        record('b', {
          life: 'starting',
          pendingOperationId: 'op-2',
          pendingOperationKind: 'reopen',
        }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('unknown pending operation kind')

    await expect(store.put(record('c', {
      pendingOperationKind: 'relaunch' as SessionRecord['pendingOperationKind'],
    }))).rejects.toThrow(/unknown pending operation kind/)
    await store.put(record('d', { pendingOperationId: 'op-3', pendingOperationKind: 'create' }))
    expect(store.get('d')?.pendingOperationKind).toBe('create')
  })

  it('round-trips the setup fields of both records of a pair', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('primary', {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'n1' },
      pendingSetup: { setupSessionId: 'setup' },
    }))
    await store.put(record('setup', {
      commands: [
        { command: 'pnpm install', cwd: 'Q:\\wt' },
        { command: 'uv sync', cwd: 'Q:\\wt\\api' },
      ],
      scriptOf: { sessionId: 'primary', phase: 'before', scriptId: 'setup', name: 'setup' },
    }))
    await store.put(record('plain', { setupSkipped: { reason: 'nothing to install' } }))
    const reloaded = await context.load()
    expect(reloaded.get('primary')?.pendingSetup).toEqual({ setupSessionId: 'setup' })
    expect(reloaded.get('setup')?.commands).toEqual([
      { command: 'pnpm install', cwd: 'Q:\\wt' },
      { command: 'uv sync', cwd: 'Q:\\wt\\api' },
    ])
    expect(reloaded.get('setup')?.scriptOf).toEqual({ sessionId: 'primary', phase: 'before', scriptId: 'setup', name: 'setup' })
    expect(reloaded.get('plain')?.setupSkipped).toEqual({ reason: 'nothing to install' })
    expect(context.reports).toEqual([])
  })

  // Every field here is optional and additive, so the version stays 1 and a file written before any
  // of them existed reads as it always did.
  it('reads a record written before the setup fields existed', async () => {
    const context = harness({ schemaVersion: 1, savedAt: 5, records: [record('a')] })
    const store = await context.load()
    expect(store.get('a')?.pendingSetup).toBeUndefined()
    expect(store.get('a')?.commands).toBeUndefined()
    expect(store.latched).toBe(false)
    expect(context.reports).toEqual([])
  })

  // A command is spliced into a shell line verbatim, so one that names nothing to run would execute
  // whatever the `&&` glue around it forms. It never reaches a launch plan from either direction.
  it('needs every command to name something to run and somewhere to run it', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        record('a', { commands: [{ command: '  ', cwd: 'Q:\\wt' }] }),
        record('b', { commands: [{ command: 'pnpm install', cwd: 'Q:\\wt' }] }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('a command needs a command')

    await expect(store.put(record('c', { commands: [{ command: 'pnpm install', cwd: '' }] })))
      .rejects.toThrow(/a command needs a cwd/)
    await expect(store.put(record('d', {
      commands: 'pnpm install' as unknown as SessionRecord['commands'],
    }))).rejects.toThrow(/commands must be an array/)
    expect(store.list()).toHaveLength(1)
  })

  // An empty list is not an install that does nothing. `LaunchPlanner` reads a record whose commands
  // name no step as an INTERACTIVE shell, so a setup carrying one would be a terminal that never
  // exits, and the session waiting for it would wait for ever with nothing said anywhere.
  it('refuses a command list with nothing in it, in both directions', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        record('a', { commands: [], scriptOf: { sessionId: 'primary', phase: 'before', scriptId: 'setup', name: 'setup' } }),
        record('b', { commands: [{ command: 'pnpm install', cwd: 'Q:\\wt' }] }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('commands must name at least one step')

    await expect(store.put(record('c', { commands: [] })))
      .rejects.toThrow(/commands must name at least one step/)
    expect(store.list()).toHaveLength(1)
  })

  // A launch plans either a shell line or a tool; a record naming both cannot say which it meant.
  it('drops a record that runs both commands and a process, aloud, and loads the others', async () => {
    const process = { tool: 'svn' as const, args: ['update', '-q', '--', '.'] }
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        record('a', { commands: [{ command: 'pnpm install', cwd: 'Q:\\wt' }], process }),
        record('b', { process }),
        record('c', { commands: [{ command: 'pnpm install', cwd: 'Q:\\wt' }] }),
        record('d', { process: { tool: 'git', args: [] } as unknown as SessionRecord['process'] }),
        record('e', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new' }, process }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b', 'c'])
    const reported = context.reports.join(' | ')
    expect(reported).toContain('record a: a record runs commands or a process, never both')
    expect(reported).toContain('record d: unknown process tool "git"')
    expect(reported).toContain('record e: only a shell record runs a process')

    await expect(store.put(record('f', { commands: [{ command: 'svn update', cwd: 'Q:\\wt' }], process })))
      .rejects.toThrow(/a record runs commands or a process, never both/)
    await expect(store.put(record('g', { process: { tool: 'svn', args: 'update' } as unknown as SessionRecord['process'] })))
      .rejects.toThrow(/process args must be a list of strings/)
  })

  // A process step runs no shell line, and its directory is part of what the launch needs.
  it('reads a process step by its tool and directory, with an empty command list', async () => {
    const process = { tool: 'svn', args: ['update', '-q', '--', '.'], cwd: '/w' }
    const step = { key: 'k1', scriptId: 'declared', name: 'svn update', commands: [], process }
    const waiting = (sessionId: string, steps: unknown[]): SessionRecord =>
      record(sessionId, { pendingSetup: { setupSessionId: 's', steps, cursor: 0 } as SessionRecord['pendingSetup'] })
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        waiting('a', [step]),
        waiting('b', [{ ...step, commands: [{ command: 'svn update', cwd: '/w' }] }]),
        waiting('c', [{ ...step, process: { ...process, cwd: '' } }]),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['a'])
    const reported = context.reports.join(' | ')
    expect(reported).toContain('a process step runs no commands')
    expect(reported).toContain('a step process needs a cwd')
  })

  // The checkout that leads the before chain of an SVN worktree is a process and nothing else.
  it('reads the checkout step of a before chain, and refuses one that runs no process', async () => {
    const checkout = { key: 'k0', scriptId: 'svn', name: 'checkout', commands: [], process: { tool: 'svn', args: ['--non-interactive', 'checkout', '-q', '--', 'file:///r@41', '.'], cwd: '/w' } }
    const waiting = (sessionId: string, steps: unknown[]): SessionRecord =>
      record(sessionId, { pendingSetup: { setupSessionId: 's', steps, cursor: 0 } as SessionRecord['pendingSetup'] })
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        waiting('a', [checkout]),
        waiting('b', [{ key: 'k0', scriptId: 'svn', name: 'checkout', commands: [{ command: 'svn checkout', cwd: '/w' }] }]),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['a'])
    expect(store.get('a')?.pendingSetup?.steps?.[0]).toEqual(checkout)
    expect(context.reports.join(' | ')).toContain('an svn step runs a process')
  })

  /*
   * A write that cannot land answers `false`, exactly as a refused one does. `put`'s contract is that
   * false means the file did not change, and every caller is written around that typed refusal
   * rather than around a rejected promise. It is a contract about the FILE and nothing more: what a
   * caller had already done - the worktree `create` had cut before it got here - is still done, and
   * naming it is that caller's job; `sessionLifecycle.test.ts` is where that half is pinned.
   *
   * The file here is a DIRECTORY: absent as far as reading goes, so nothing latches, and impossible
   * to write on every platform.
   */
  it('answers false and says so when the file cannot be written', async () => {
    const context = harness()
    mkdirSync(context.file)
    const store = await context.load()
    expect(store.latched).toBe(false)

    expect(await store.put(record('a'))).toBe(false)
    expect(store.list()).toEqual([])
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain('could not be written')

    // Not latched by it either: the file was never read as damaged, and the next write may well land.
    expect(store.latched).toBe(false)
  })

  // pendingSetup is the only link from a session waiting on its setup to the session doing it, and
  // the only marker retrySetup works from. One that names nobody would end the session it belongs to.
  it('needs a pendingSetup to name its setup session', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        record('a', { pendingSetup: { setupSessionId: '' } }),
        record('b', { pendingSetup: { setupSessionId: 'setup' } }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('pendingSetup needs a setupSessionId')

    await expect(store.put(record('c', {
      pendingSetup: {} as SessionRecord['pendingSetup'],
    }))).rejects.toThrow(/pendingSetup needs a setupSessionId/)
    expect(store.list()).toHaveLength(1)
  })

  // A chain's steps are what the next step is launched from, so each is checked by its shape.
  it('reads a chain wait by the shape of its steps and a cursor inside them', async () => {
    const step = { key: 'k1', scriptId: 'declared', name: 'codegen', commands: [{ command: 'pnpm codegen', cwd: '/w' }] }
    const waiting = (sessionId: string, steps: unknown[], cursor?: number): SessionRecord =>
      record(sessionId, { pendingSetup: { setupSessionId: 's', steps, cursor } as SessionRecord['pendingSetup'] })
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        waiting('a', [step], 1),
        waiting('b', [{ ...step, scriptId: 'merge-resolve' }], 0),
        waiting('c', [{ ...step, commands: [] }], 0),
        waiting('d', [step]),
        waiting('e', [step], 0),
        record('f', {
          scriptOf: { sessionId: 'e', phase: 'before', scriptId: 'declared', name: 'codegen', stepKey: 'k1' },
        }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['e', 'f'])
    const reported = context.reports.join(' | ')
    expect(reported).toContain('pendingSetup cursor must be an index into its 1 steps')
    expect(reported).toContain('unknown step script "merge-resolve"')
    expect(reported).toContain('commands must name at least one step')

    await expect(store.put(record('g', {
      scriptOf: { sessionId: 'e', phase: 'before', scriptId: 'declared', name: 'codegen', stepKey: '' },
    }))).rejects.toThrow(/scriptOf stepKey must be a non-empty string/)
  })

  // The after chain of a Finish names the run it waits on, so it is checked by the same shapes.
  it('reads the checks of a Finish by their steps, their cursor and their result', async () => {
    const steps = [{ key: 'k1', scriptId: 'declared', name: 'tests', commands: [{ command: 'pnpm test', cwd: '/w' }] }]
    const finishing = (sessionId: string, finishChecks: unknown): SessionRecord =>
      record(sessionId, { finishChecks: finishChecks as SessionRecord['finishChecks'] })
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        finishing('a', { runId: 't', steps, cursor: 0, startedAt: 1 }),
        finishing('b', { runId: 't', steps, cursor: 0, startedAt: 1, result: { kind: 'failed', reason: 'exit 1', at: 2 } }),
        finishing('c', { runId: 't', steps, cursor: 1, startedAt: 1 }),
        finishing('d', { runId: '', steps, cursor: 0, startedAt: 1 }),
        finishing('e', { runId: 't', steps, cursor: 0, startedAt: 1, result: { kind: 'skipped', at: 2 } }),
        finishing('f', { runId: 't', steps, cursor: 0, startedAt: 1, result: { kind: 'failed', at: 2 } }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(store.list().filter((entry) => entry.finishChecks !== undefined).map((entry) => entry.sessionId))
      .toEqual(['a', 'b'])
    const reported = context.reports.join(' | ')
    expect(reported).toContain('record "c": dropping its Finish checks (finishChecks cursor must be an index into its 1 steps)')
    expect(reported).toContain('finishChecks needs a runId')
    expect(reported).toContain('unknown finishChecks result "skipped"')
    expect(reported).toContain('a failed finishChecks result needs a reason')
  })

  // A setup step passes as a step, then has no after definition: every reconcile pass would throw on it.
  it('drops Finish checks holding a step that is not a declared check, keeps the session, and refuses to write one', async () => {
    const step = { key: 'k1', scriptId: 'setup', name: 'setup', commands: [{ command: 'pnpm install', cwd: '/w' }] }
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('a', { finishChecks: { runId: 't', steps: [step], cursor: 0, startedAt: 1 } } as Partial<SessionRecord>)],
    })
    const store = await context.load()

    expect(store.get('a')).not.toBeNull()
    expect(store.get('a')?.finishChecks).toBeUndefined()
    expect(context.reports).toEqual([expect.stringContaining('dropping its Finish checks (finishChecks steps: a "setup" step is not a check)')])
    await expect(store.put(record('b', { finishChecks: { runId: 't', steps: [step], cursor: 0, startedAt: 1 } } as Partial<SessionRecord>)))
      .rejects.toThrow(/a "setup" step is not a check/)
  })

  // The script link points the other way along the same link, and a marker that says nothing is
  // checked the same way as the one that says nobody. An old `setupFor` that names nobody is read
  // through the link it migrates into, so it is still dropped aloud.
  it('needs a script link that names a session and a setupSkipped that gives a reason', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [
        { ...record('a'), setupFor: '' },
        record('b', { scriptOf: { sessionId: 'primary', phase: 'before', scriptId: 'setup', name: 'setup' } }),
      ],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('scriptOf sessionId must be a non-empty string')

    await expect(store.put(record('c', {
      scriptOf: { sessionId: 7 } as unknown as SessionRecord['scriptOf'],
    }))).rejects.toThrow(/scriptOf sessionId must be a non-empty string/)
    await expect(store.put(record('d', {
      setupSkipped: { reason: 7 } as unknown as SessionRecord['setupSkipped'],
    }))).rejects.toThrow(/setupSkipped needs a reason string/)
    expect(store.list()).toHaveLength(1)
  })

  it('accepts every directory mode and refuses an unknown one', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('a', { directory: { mode: 'adHoc', path: 'D:\\tmp' } }))
    await store.put(record('b', {
      directory: { mode: 'project', categoryId: 'c1', projectPath: 'Q:\\p' },
    }))
    await expect(store.put(record('c', {
      directory: { mode: 'elsewhere' } as unknown as SessionRecord['directory'],
    }))).rejects.toThrow(/unknown directory mode/)
    expect(store.list()).toHaveLength(2)
  })

  it('reports legacy identity migration once even for a large session archive', async () => {
    const context = harness({schemaVersion: 1, savedAt: 5, records: Array.from({length: 1500}, (_, index) =>
      record(`legacy-${index}`, {kind: 'agent', agent: {
        agentId: 'codex', launchMode: 'new', nativeSessionId: `old-${index}`,
      }}))})
    const store = await context.load()
    expect(store.list()).toHaveLength(1500)
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain('1500 old inferred bindings are unverified')
    expect(store.get('legacy-1499')?.agent?.unverifiedNativeSessionId).toBe('old-1499')
  })
  it('preserves an unreadable lifecycle without rewriting the file and refuses every mutation of that record', async () => {
    const current = record('worker', { worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' } })
    const h = harness({ schemaVersion: 1, records: [{ ...current, worktreeLifecycle: { version: -1, phase: 'future' } }] })
    const before = readFileSync(h.file, 'utf8')
    const store = await h.load()
    expect(store.list()).toHaveLength(1)
    expect(store.get('worker')?.worktree).toEqual(current.worktree)
    expect(store.get('worker')?.worktreeLifecycle).toMatchObject({ phase: 'waiting', unreadable: expect.any(String) })
    expect(readFileSync(h.file, 'utf8')).toBe(before)
    expect(await store.update('worker', (record) => ({ ...record, title: 'lost' }))).toBe(false)
    expect(await store.put({ ...store.get('worker')!, title: 'lost' })).toBe(false)
    expect(await store.remove('worker')).toBe(false)
    expect(await store.clearActions('worker')).toBe(false)
    expect(await store.adopt(current)).toBe(false)
    expect(await store.put(record('other'))).toBe(true)
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records.find((record: SessionRecord) => record.sessionId === 'worker'))
      .toEqual(JSON.parse(before).records[0])
    expect(h.reports.join(' ')).toContain('read-only')
    expect((await h.load()).get('worker')?.worktreeLifecycle).toEqual(store.get('worker')?.worktreeLifecycle)
  })

  it.each(['journal', 'wait'])('quarantines unknown nested %s fields even with another malformed record field', async (field) => {
    const lifecycle = { version: 1, actionId: 'action', phase: 'waiting', step: 'syncing', outOfDate: 0,
      journal: [{ stepId: 'update', kind: 'update', runId: 'run', attempt: 1, startedAt: 1, ...field === 'journal' ? { future: 'retain' } : {} }],
      wait: { kind: 'svn-failed', reason: 'inspect', at: 1, ...field === 'wait' ? { future: 'retain' } : {} },
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } } }
    const raw = { ...record('worker', { worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' } }), worktreeLifecycle: lifecycle, life: 'future-life' }
    const h = harness({ schemaVersion: 1, records: [raw] }), before = readFileSync(h.file, 'utf8')
    const store = await h.load()
    expect(store.get('worker')?.worktreeLifecycle?.unreadable).toBeDefined()
    expect(store.get('worker')?.worktreeLifecycle?.unreadable).toContain(h.file)
    expect(store.get('worker')?.worktree).toEqual(raw.worktree)
    expect(store.quarantinedSessionIds().has('worker')).toBe(true)
    expect(readFileSync(h.file, 'utf8')).toBe(before)
    await store.put(record('other'))
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records.find((row: SessionRecord) => row.sessionId === 'worker')).toEqual(raw)
  })

  it.each(['update', 'execution', 'preparation'])('preserves an unknown %s payload and its journal through unrelated writes', async (field) => {
    const current = record('worker', { worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' } })
    const lifecycle = { version: 1, actionId: 'a', phase: 'active', outOfDate: 0,
      journal: [{ stepId: 'commit', kind: 'commit', runId: 'run', attempt: 1, startedAt: 1 }],
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } }, [field]: { future: true, evidence: 'must survive' } }
    const h = harness({ schemaVersion: 1, records: [{ ...current, worktreeLifecycle: lifecycle }] })
    const before = readFileSync(h.file, 'utf8')
    const store = await h.load()
    expect(readFileSync(h.file, 'utf8')).toBe(before)
    expect(store.get('worker')?.worktreeLifecycle?.unreadable).toBeDefined()
    await store.put(record('other'))
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records.find((record: SessionRecord) => record.sessionId === 'worker').worktreeLifecycle).toEqual(lifecycle)
  })

  it('keeps a newer unknown action record in a non-committing lifecycle wait', async () => {
    const current = record('newer', { worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' } })
    const h = harness({ schemaVersion: 1, records: [{ ...current, svnAction: { kind: 'finish', stage: 'future-stage', actionId: 'future' } }] })
    const store = await h.load()
    expect(store.get('newer')?.worktree).toEqual(current.worktree)
    expect(store.get('newer')?.svnAction).toBeUndefined()
    expect(store.get('newer')?.worktreeLifecycle).toMatchObject({ phase: 'waiting', wait: { kind: 'svn-failed' } })
    expect(store.get('newer')?.worktreeLifecycle?.step).toBeUndefined()
  })

  it('keeps a session with an unknown action and malformed memory without losing lifecycle evidence', async () => {
    const lifecycle = { version: 12, actionId: 'action', phase: 'finishing', step: 'committing', outOfDate: 2,
      journal: [{ stepId: 'commit-1', kind: 'commit', attempt: 1, startedAt: 2, runId: 'run' }],
      facts: { worker: { liveness: 'alive', resumeFailures: 1, ready: { at: 1, hashes: { a: 'hash' } } },
        syncedAt: { revision: 17, at: 2 }, fingerprint: 'proof' } }
    const current = record('combined', { worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' } })
    for (const previous of [undefined, lifecycle]) {
      const h = harness({ schemaVersion: 1, records: [{ ...current,
        worktree: { ...current.worktree, conflictMemory: { paths: 'damaged' } }, worktreeLifecycle: previous,
        svnAction: { kind: 'finish', stage: 'future-stage', actionId: 'future' } }] })
      const store = await h.load()
      expect(store.list()).toHaveLength(1)
      expect(store.get('combined')?.worktree?.conflictMemory).toBeUndefined()
      const state = store.get('combined')?.worktreeLifecycle
      expect(state).toMatchObject({ phase: 'waiting', wait: { kind: 'svn-failed' } })
      expect(state?.step).toBeUndefined()
      if (previous !== undefined) {
        expect(state?.unreadable).toBeDefined()
        expect(JSON.parse(readFileSync(h.file, 'utf8')).records[0].worktreeLifecycle).toEqual(previous)
      }
      expect((await h.load()).get('combined')?.worktreeLifecycle).toEqual(state)
    }
  })

})
