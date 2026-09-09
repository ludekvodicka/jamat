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
      await expect(store.put(record('a', { resolveFor: 42 } as unknown as Partial<SessionRecord>)))
        .rejects.toThrow(/resolveFor must be a non-empty string/)
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
        resolveFor: undefined,
      }))).toBe(true)
      expect(store.get('a')?.worktreeMerge?.phase).toBe('resolving')
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

  // Absence is the answer for both: a record of the tree, and a session nobody has finished with.
  // Storing `false` would be a second way to say nothing, and two ways is how a reader starts guessing.
  it('takes presentation and completed only in the shapes that mean something', async () => {
    const context = harness()
    const store = await context.load()
    await store.put(record('a', { presentation: 'tab' }))
    await store.put(record('b', { completed: true }))
    await store.put(record('c'))
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c'])
    await expect(store.put({
      ...record('d'),
      presentation: 'window' as SessionRecord['presentation'],
    })).rejects.toThrow(/unknown presentation/)
    await expect(store.put({
      ...record('d'),
      completed: false as unknown as SessionRecord['completed'],
    })).rejects.toThrow(/completed must be true or absent/)
    expect(store.get('d')).toBeNull()
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
      setupFor: 'primary',
    }))
    await store.put(record('plain', { setupSkipped: { reason: 'nothing to install' } }))
    const reloaded = await context.load()
    expect(reloaded.get('primary')?.pendingSetup).toEqual({ setupSessionId: 'setup' })
    expect(reloaded.get('setup')?.commands).toEqual([
      { command: 'pnpm install', cwd: 'Q:\\wt' },
      { command: 'uv sync', cwd: 'Q:\\wt\\api' },
    ])
    expect(reloaded.get('setup')?.setupFor).toBe('primary')
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
        record('a', { commands: [], setupFor: 'primary' }),
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

  // setupFor points the other way along the same link, and a marker that says nothing is checked the
  // same way as the one that says nobody.
  it('needs a setupFor that names a session and a setupSkipped that gives a reason', async () => {
    const context = harness({
      schemaVersion: 1,
      savedAt: 5,
      records: [record('a', { setupFor: '' }), record('b', { setupFor: 'primary' })],
    })
    const store = await context.load()
    expect(store.list().map((entry) => entry.sessionId)).toEqual(['b'])
    expect(context.reports[0]).toContain('setupFor must be a non-empty string')

    await expect(store.put(record('c', {
      setupFor: 7 as unknown as SessionRecord['setupFor'],
    }))).rejects.toThrow(/setupFor must be a non-empty string/)
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
})
