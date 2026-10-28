import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TreeRemovalListener } from '../../shared/treeRemoval'
import type { SvnResult, SvnStatusRow, SvnWorktreeLocation } from '../../svn/svn.types'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { WorktreeResultsStore } from '../results/worktreeResultsStore'
import type { SessionFinishPress, SessionsOpResult, SessionStepProgress, SvnFinishWorktreeResult, SvnLabelledRevision } from '../../sessionManager/sessionManagerApi.types'
import type { SessionSteps } from '../../sessionManager/worktreeSessionRuntime'
import { type SessionStepFacts, SessionStepWords } from '../../sessionManager/worktreeSessionRuntime'
import type { SvnLabelsRead } from './svnRevisionLabels'
import { type SvnActionsPort, type SvnCleanupPort, SvnWorktreeFinishFlow } from './svnWorktreeFinishFlow'
import { type SvnRemovalPort, SvnWorktreeRemoval } from '../removal/svnWorktreeRemoval'
import { WorktreeCleanupPacing } from '../removal/worktreeCleanupPacing'

describe('lib-orchestrator/sessionManager/lifecycle/svnWorktreeFinishFlow', () => {
  const ownerConst = 'Q:\\Work\\App'
  const worktreeConst = `${ownerConst}\\.worktrees\\014-fix-login`
  const urlConst = 'https://svn.test/repos/app/trunk'
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  const row = (path: string): SvnStatusRow => ({ kind: 'item', conflict: false, path })
  const ok = <T>(value: T): SvnResult<T> => ({ ok: true, value })

  /** The svn reads of the cleanup and the disk writes of the removal, logged in one list. */
  class FakeSvn implements SvnCleanupPort, SvnRemovalPort {
    readonly log: string[]
    changesByPath: Record<string, SvnStatusRow[] | string> = {}
    rename: 'renamed' | 'in-use' | 'absent' | Error = 'renamed'
    purge: 'removed' | 'undeleted' = 'removed'
    presentValue = true
    /** Holds every `changes` read until it settles, the way a slow `svn status` of a large worktree does. */
    gate: Promise<void> | null = null

    constructor(log: string[]) {
      this.log = log
    }

    async removalSource(location: SvnWorktreeLocation) { return { ok: true as const, value: { path: location.worktreePath, aside: false, present: true } } }

    async removalStatus(): Promise<SvnResult<import('../../svn/svn.types').SvnRemovalRow[]>> {
      return { ok: true, value: [] }
    }

    async changes(path: string): Promise<SvnResult<SvnStatusRow[]>> {
      this.log.push(`changes ${path}`)
      await this.gate
      const value = this.changesByPath[path] ?? []
      return typeof value === 'string' ? { ok: false, code: 'svn-failed', detail: value } : ok(value)
    }

    present(worktreePath: string): Promise<boolean> {
      this.log.push(`present ${worktreePath}`)
      return Promise.resolve(this.presentValue)
    }

    renameAside(location: SvnWorktreeLocation): Promise<SvnResult<'renamed' | 'in-use' | 'absent'>> {
      this.log.push(`renameAside ${location.worktreePath} ${location.directoryId ?? '-'}`)
      return this.rename instanceof Error ? Promise.reject(this.rename) : Promise.resolve(ok(this.rename))
    }

    purgeAside(_location: SvnWorktreeLocation, onProgress?: TreeRemovalListener): Promise<SvnResult<'removed' | 'undeleted'>> {
      this.log.push('purgeAside')
      onProgress?.({ phase: 'counting', done: 4, total: null })
      onProgress?.({ phase: 'deleting', done: 4, total: 4 })
      return Promise.resolve(ok(this.purge))
    }

    removeEmptyWorktreesDir(ownerDir: string): Promise<void> {
      this.log.push(`removeEmptyWorktreesDir ${ownerDir}`)
      return Promise.resolve()
    }
  }

  /** The SVN action as the facade reaches it: every press is logged and answered as a case says. */
  class FakeActions implements SvnActionsPort {
    readonly presses: { sessionId: string; press: SessionFinishPress }[] = []
    answer: SessionsOpResult<{ actionId: string | null }> = { ok: true, value: { actionId: 'action-1' } }
    ending: SvnFinishWorktreeResult | null = 'removed'
    settledCalls: string[] = []

    start(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ actionId: string | null }>> {
      this.presses.push({ sessionId, press })
      return Promise.resolve(this.answer)
    }

    settled(sessionId: string): Promise<SvnFinishWorktreeResult | null> {
      this.settledCalls.push(sessionId)
      return Promise.resolve(this.ending)
    }
  }

  /** The session steps as a log: each `at` in words, each `clear`, and what is live now. */
  class FakeSteps implements Pick<SessionSteps, 'at' | 'clear'> {
    readonly log: string[] = []
    readonly live = new Map<string, string>()

    at(sessionId: string, facts: SessionStepFacts, progress: SessionStepProgress | null = null): void {
      const words = SessionStepWords.of(facts, progress)
      const text = words.detail === null ? words.text : `${words.text} | ${words.detail}`
      this.log.push(text)
      this.live.set(sessionId, text)
    }

    clear(sessionId: string): boolean {
      this.log.push('clear')
      return this.live.delete(sessionId)
    }
  }

  interface Harness {
    flow: SvnWorktreeFinishFlow
    steps: FakeSteps
    store: SessionRecordsStore
    svn: FakeSvn
    actions: FakeActions
    log: string[]
    ended: string[]
    /** The main copies a cleanup that left a landed row asked the manager to read again. */
    landedDue: string[]
    record: () => SessionRecord | null
    results: WorktreeResultsStore
    /** What `ownCommits` answers for the worktree before the cleanup removes it. */
    own: { value: SvnLabelledRevision[]; reads: number; reported: SvnLabelsRead[] }
  }

  async function harness(options: {
    overrides?: Partial<SessionRecord>
    refusal?: SessionsOpResult<never>
    /** Runs before each step on the operation queue, the way a reopen queued ahead of it would. */
    beforeQueue?: (store: SessionRecordsStore) => Promise<void>
  } = {}): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-svn-finish-flow-'))
    created.push(root)
    const log: string[] = []
    const store = await SessionRecordsStore.load(join(root, 'session-records.json'), {
      snapshotsDirectory: join(root, 'snapshots'),
      report: () => undefined,
    })
    await store.put(recordOf(options.overrides))
    const svn = new FakeSvn(log)
    const actions = new FakeActions()
    const ended: string[] = []
    const landedDue: string[] = []
    const steps = new FakeSteps()
    const removal = new SvnWorktreeRemoval({
      skillRoots: [],
      results: { savedDirectoryOf: (id) => join(root, 'results', id, 'saved') },
      records: store,
      svn,
      onQueue: async (work) => {
        await options.beforeQueue?.(store)
        return work()
      },
      changed: () => undefined,
      steps,
      now: () => 5_000,
    })
    const own: Harness['own'] = { value: [], reads: 0, reported: [] }
    const results = new WorktreeResultsStore(join(root, 'results'), {
      now: () => 5_000,
      logs: {
        existingPathOf: async () => null,
        briefPathOf: (parentId, actionId) => join(root, parentId, `${actionId}-conflicts.txt`),
        mergeBriefPathOf: (parentId, actionId) => join(root, parentId, `${actionId}-merge.md`),
      },
      report: () => undefined,
    })
    let minted = 0
    const flow = new SvnWorktreeFinishFlow({
      records: store,
      svn,
      removal,
      actions,
      labels: {
        ownCommits: async (_path, _receipts, _since, onRead) => {
          own.reads += 1
          for (const read of own.reported) onRead?.(read)
          return { ok: true, value: own.value }
        },
      },
      results,
      changed: () => undefined,
      steps,
      ended: (sessionId) => { ended.push(sessionId) },
      landedDue: (mainCopy) => { landedDue.push(mainCopy) },
      report: () => undefined,
      now: () => 5_000,
      newId: () => `cleanup-${++minted}`,
    })
    return { flow, steps, store, svn, actions, log, ended, landedDue, record: () => store.get('s1'), results, own }
  }

  function recordOf(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'agent',
      title: '014 - fix login',
      createdAt: 0,
      life: 'ended',
      directory: { mode: 'project', categoryId: 'work', projectPath: ownerConst },
      binding: null,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      worktree: {
        worktreePath: worktreeConst,
        branch: urlConst,
        baseCommit: 'r10',
        repositoryRoot: ownerConst,
        kind: 'svn',
        directoryId: '1:2:3',
        agentStartedAt: 1,
      },
      ...overrides,
    }
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate()) return
      await new Promise((resolve) => setImmediate(resolve))
    }
    throw new Error('the condition never held')
  }

  it('takes Commit, Keep and Discard as presses of the SVN action, which runs the checks itself', async () => {
    const it_ = await harness()

    expect(it_.flow.ownsChecks).toBe(true)
    expect(await it_.flow.finish('s1', { choice: 'commit', acknowledgeSetup: 'hash-1', requestedBy: 'window' }))
      .toEqual({ ok: true, value: { actionId: 'action-1' } })
    expect(await it_.flow.keep('s1')).toEqual({ ok: true, value: undefined })
    expect(it_.actions.presses).toEqual([
      { sessionId: 's1', press: { choice: 'commit', acknowledgeSetup: 'hash-1', requestedBy: 'window' } },
      { sessionId: 's1', press: { choice: 'keep', requestedBy: 'window' } },
    ])
  })

  it('answers the Discard of sessions.discardWorktree once the action removed the worktree, and names a holder', async () => {
    const removed = await harness()
    expect(await removed.flow.discard('s1')).toEqual({ ok: true, value: undefined })
    expect(removed.actions.presses).toEqual([{ sessionId: 's1', press: { choice: 'discard', requestedBy: 'cli' } }])
    expect(removed.actions.settledCalls).toEqual(['s1'])

    const held = await harness()
    held.actions.ending = 'in-use'
    expect(await held.flow.discard('s1')).toMatchObject({ ok: false, code: 'locked' })
    held.actions.ending = 'undeleted'
    expect(await held.flow.discard('s1')).toMatchObject({ ok: false, code: 'svn-failed' })
  })

  it('refuses the Discard of a running session as before; the window stops it first through Finish', async () => {
    const it_ = await harness({ overrides: { life: 'live', binding: { hostInstanceId: 'h', generation: 1 } } })

    expect(await it_.flow.discard('s1')).toEqual({ ok: false, code: 'live-refused', detail: 'This session is still running; stop it first' })
    expect(it_.actions.presses).toEqual([])
  })

  it('does not require the retired review-run composer', async () => {
    const refusal: SessionsOpResult<never> = { ok: false, code: 'review-unavailable', detail: 'no commit dialog' }
    const it_ = await harness({ refusal })

    expect('finishRefusal' in it_.flow).toBe(false)
  })

  it('offers Commit, Keep and Discard without reading the worktree', async () => {
    const it_ = await harness()

    expect(it_.flow.choicesOf({ record: it_.record()! })).toEqual(['commit', 'keep', 'discard'])
    expect(it_.log).toEqual([])
  })

  it('offers no Commit where Finish refuses it as never-started, so the dialog keeps only Keep and Discard', () => {
    const shell = recordOf({ kind: 'shell', worktree: { ...recordOf().worktree!, agentStartedAt: undefined } })
    expect(SvnWorktreeFinishFlow.choicesFor(shell, false)).toEqual(['keep', 'discard'])
    expect(SvnWorktreeFinishFlow.choicesFor({ ...shell, life: 'live' }, false)).toEqual(['keep', 'discard'])
  })

  it('offers Commit while the cleanup after the end waits, because the review reads what is left to land', () => {
    const record = recordOf({ life: 'ended', exitReason: 'stopped', endedAt: 4_000,
      worktreeCleanup: { phase: 'pending', trigger: 'remove-when-ended', requestedAt: 0, attempts: 0 } })
    expect(SvnWorktreeFinishFlow.choicesFor(record, false)).toEqual(['commit', 'keep', 'discard'])
    expect(SvnWorktreeFinishFlow.choicesFor(record, true)).toEqual(['keep', 'discard'])
  })

  describe('the cleanup after the session ended', () => {
    const pending = (trigger: NonNullable<SessionRecord['worktreeCleanup']>['trigger'] = 'committed', reason?: string) =>
      ({ worktreeCleanup: { phase: 'pending' as const, trigger, requestedAt: 1, attempts: 1, lastAttemptAt: 2, ...reason === undefined ? {} : { reason } } })

    it('removes a clean worktree, leaves a tombstone and ends the session', async () => {
      const it_ = await harness({ overrides: pending() })

      await it_.flow.cleanUp('s1')

      const record = it_.record()
      expect(record?.worktree).toBeUndefined()
      expect(record?.worktreeCleanup).toBeUndefined()
      expect(record?.completed).toBe(true)
      expect(record?.retiredWorktree).toEqual({
        worktreePath: worktreeConst, kind: 'svn', revisions: [], removedAt: 5_000, ownerDir: ownerConst, directoryId: '1:2:3',
      })
      expect(it_.log).toEqual([
        `present ${worktreeConst}`,
        `changes ${worktreeConst}`,
        `renameAside ${worktreeConst} 1:2:3`,
        'purgeAside',
        `removeEmptyWorktreesDir ${ownerConst}`,
      ])
      expect(it_.ended).toEqual(['s1'])
    })

    it('says which of how many revisions its own-commits read reads', async () => {
      const it_ = await harness({ overrides: pending() })
      const root = { path: `${worktreeConst}\\lib`, own: 'lib', changed: [] }
      it_.own.reported = [{ kind: 'status', root }, { kind: 'own-commit', root, revision: 7, index: 1, count: 1 }]

      await it_.flow.cleanUp('s1')

      expect(it_.steps.log.slice(1, 4)).toEqual([
        'Reading what the worktree committed | svn status -v --xml',
        'Reading what the worktree committed | svn status -v --xml in lib',
        'Reading what the worktree committed | svn log -v -r7 (1 of 1 revision) in lib',
      ])
    })

    it('shows its reads and the phases of the removal as the step, and clears it at its end', async () => {
      const it_ = await harness({ overrides: pending() })

      await it_.flow.cleanUp('s1')

      expect(it_.steps.log).toEqual([
        'Checking what is left in the worktree | svn status --xml',
        'Reading what the worktree committed | svn status -v --xml',
        `Waiting for other operations | ${worktreeConst}`,
        `Moving the worktree aside | ${worktreeConst}.deleting`,
        `Saving the files to keep before deleting | ${worktreeConst}.deleting`,
        'Counting the files to delete | 4 files so far',
        'Removing the worktree | 4 of 4 files',
        'Recording the removal | session record',
        'clear',
      ])
      expect(it_.steps.live.size).toBe(0)
    })

    it('leaves no step when it keeps the worktree, finds it in use, leaves a rest, or a reopen won', async () => {
      const kept = await harness({ overrides: pending() })
      kept.svn.changesByPath[worktreeConst] = [row('notes.txt')]
      const held = await harness({ overrides: pending() })
      held.svn.rename = 'in-use'
      const half = await harness({ overrides: pending() })
      half.svn.purge = 'undeleted'
      const reopened = await harness({
        overrides: pending(),
        beforeQueue: async (store) => {
          const current = store.get('s1')
          if (current?.life === 'ended') await store.put({ ...current, life: 'starting', pendingOperationId: 'op-1', pendingOperationKind: 'reopen' })
        },
      })

      for (const it_ of [kept, held, half, reopened]) {
        await it_.flow.cleanUp('s1')
        expect(it_.steps.log.at(-1)).toBe('clear')
        expect(it_.steps.live.size).toBe(0)
      }
      expect(kept.steps.log).toEqual(['Checking what is left in the worktree | svn status --xml', 'clear'])
      expect(held.steps.log.at(-2)).toBe(`Moving the worktree aside | ${worktreeConst}.deleting`)
      expect(half.steps.log.at(-2)).toBe('Removing the worktree | 4 of 4 files')
    })

    // Removed with the main-copy landing: a 3.10 `unlanded` verdict no longer waits for the main copy.
    it('removes a clean worktree whose cleanup a 3.10 build left waiting as unlanded', async () => {
      const it_ = await harness({ overrides: pending('committed', 'unlanded r12: src/a.txt') })

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.retiredWorktree?.worktreePath).toBe(worktreeConst)
      expect(it_.ended).toEqual(['s1'])
    })

    it('keeps a worktree with one unversioned file for good', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.changesByPath[worktreeConst] = [row('notes.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change', trigger: 'committed' })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.log.some((entry) => entry.startsWith('renameAside'))).toBe(false)
      expect(it_.ended).toEqual([])

      // Terminal: a second apply finds nothing pending and reads nothing.
      it_.log.length = 0
      await it_.flow.cleanUp('s1')
      expect(it_.log).toEqual([])
    })

    it('stays pending when svn cannot read the worktree', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.changesByPath[worktreeConst] = 'E155037: previous operation has not finished'

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({
        phase: 'pending', reason: 'svn status failed: E155037: previous operation has not finished',
      })
    })

    it('stays pending as in use while a process holds the directory', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.rename = 'in-use'

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'pending', reason: 'in use', attempts: 1 })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.ended).toEqual([])
    })

    it('does nothing when a reopen took the queue first', async () => {
      const it_ = await harness({
        overrides: pending(),
        beforeQueue: async (store) => {
          const current = store.get('s1')
          if (current?.life === 'ended') await store.put({ ...current, life: 'starting', pendingOperationId: 'op-1', pendingOperationKind: 'reopen' })
        },
      })

      await it_.flow.cleanUp('s1')

      expect(it_.log.some((entry) => entry.startsWith('renameAside'))).toBe(false)
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.record()?.worktreeCleanup).toEqual(pending().worktreeCleanup)
      expect(it_.ended).toEqual([])
    })

    it('removes after an unfinished Discard without asking about changes', async () => {
      const it_ = await harness({ overrides: pending('discard-unfinished') })
      it_.svn.changesByPath[worktreeConst] = [row('a.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.log.some((entry) => entry.startsWith('changes'))).toBe(false)
      expect(it_.record()?.retiredWorktree).toBeDefined()
      expect(it_.ended).toEqual(['s1'])
    })

    it('counts a worktree already gone as removed', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.presentValue = false
      it_.svn.rename = 'absent'

      await it_.flow.cleanUp('s1')

      expect(it_.log.some((entry) => entry.startsWith('changes'))).toBe(false)
      expect(it_.record()?.retiredWorktree).toBeDefined()
      expect(it_.ended).toEqual(['s1'])
    })

    it('checks the changes of an unfinished Discard once the session ran after it, and keeps the new work', async () => {
      const it_ = await harness({ overrides: { ...pending('discard-unfinished'), endedAt: 3 } })
      it_.svn.changesByPath[worktreeConst] = [row('after-reopen.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change', trigger: 'discard-unfinished' })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.log.some((entry) => entry.startsWith('renameAside'))).toBe(false)
      expect(it_.ended).toEqual([])
    })

    it('keeps a changed worktree after an unfinished Discard, a reopen and a stop', async () => {
      const it_ = await harness({ overrides: pending('discard-unfinished') })
      // What the lifecycle writes for the reopen, and then for the stop that ends the new run.
      const discarded = it_.record()
      if (discarded === null) throw new Error('the record is gone')
      await it_.store.put(WorktreeCleanupPacing.relaunched({ ...discarded, life: 'starting', pendingOperationId: 'op-1', pendingOperationKind: 'reopen' }, 6_000))
      const reopened = it_.record()
      if (reopened === null) throw new Error('the record is gone')
      await it_.store.put({ ...reopened, life: 'ended', exitReason: 'stopped', pendingOperationId: undefined, pendingOperationKind: undefined })
      it_.svn.changesByPath[worktreeConst] = [row('after-reopen.txt')]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change', trigger: 'removal-unfinished' })
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.ended).toEqual([])
    })

    it('keeps the revisions of the last outcome in the tombstone of a removal that finishes later', async () => {
      const it_ = await harness({ overrides: {
        ...pending('removal-unfinished'),
        worktreeOutcome: { result: 'committed', revisions: ['https://svn.test/repos/app:r12'], main: 'none', worktree: 'in-use', lines: [], at: 3 },
      } })

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.retiredWorktree?.revisions).toEqual(['https://svn.test/repos/app:r12'])
      expect(it_.ended).toEqual(['s1'])
    })

    it('records a removal exception and releases the worktree for a later retry', async () => {
      const it_ = await harness({ overrides: pending() })
      it_.svn.rename = new Error('EBUSY: the disk went away')

      await it_.flow.cleanUp('s1')
      expect(it_.record()?.worktreeCleanup?.reason).toContain('the disk went away')

      expect(it_.flow.cleaningNow('s1')).toBe(false)
      expect(it_.record()?.worktree).toBeDefined()
      expect(it_.ended).toEqual([])

      it_.svn.rename = 'renamed'
      await it_.flow.cleanUp('s1')
      expect(it_.record()?.retiredWorktree).toBeDefined()
      expect(it_.ended).toEqual(['s1'])
    })

    it('makes a Finish and a Discard pressed while it judges wait, then answer what it left without an action of their own', async () => {
      const it_ = await harness({ overrides: pending('remove-when-ended') })
      let open!: () => void
      it_.svn.gate = new Promise((resolve) => { open = resolve })

      const cleaning = it_.flow.cleanUp('s1')
      await until(() => it_.log.includes(`changes ${worktreeConst}`))
      expect(it_.flow.cleaningNow('s1')).toBe(true)
      // The removal under way owns the worktree, so Finish offers nothing to land.
      expect(it_.flow.choicesOf({ record: it_.record()! })).toEqual(['keep', 'discard'])
      const finish = it_.flow.finish('s1', { choice: 'commit', requestedBy: 'window' })
      const discard = it_.flow.discard('s1')
      open()
      await cleaning

      expect(await finish).toEqual({ ok: true, value: { actionId: null } })
      expect(await discard).toEqual({ ok: true, value: undefined })
      expect(it_.flow.cleaningNow('s1')).toBe(false)
      expect(it_.actions.presses).toEqual([])
      expect(it_.log.filter((entry) => entry.startsWith('renameAside'))).toHaveLength(1)
      expect(it_.record()?.retiredWorktree?.worktreePath).toBe(worktreeConst)
      expect(it_.ended).toEqual(['s1'])
    })

    it('lets a Finish pressed while it judges go to the action after it kept a changed worktree', async () => {
      const it_ = await harness({ overrides: pending('remove-when-ended') })
      it_.svn.changesByPath[worktreeConst] = [row('a.txt')]
      let open!: () => void
      it_.svn.gate = new Promise((resolve) => { open = resolve })

      const cleaning = it_.flow.cleanUp('s1')
      await until(() => it_.log.includes(`changes ${worktreeConst}`))
      const finish = it_.flow.finish('s1', { choice: 'commit', requestedBy: 'window' })
      open()
      await cleaning

      expect(await finish).toEqual({ ok: true, value: { actionId: 'action-1' } })
      expect(it_.record()?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change' })
      expect(it_.actions.presses).toHaveLength(1)
      expect(it_.log.some((entry) => entry.startsWith('renameAside'))).toBe(false)
    })

    it('leaves a running session, an SVN action and a kept or missing cleanup alone', async () => {
      const action: SessionRecord['svnAction'] = {
        kind: 'finish', actionId: 'a', stage: 'reviewing', root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0,
        rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1,
      }
      for (const overrides of [
        { ...pending(), life: 'live' as const },
        { ...pending(), svnAction: action },
        { ...pending(), svnAction: { ...action, needs: { kind: 'review-cancelled' as const, reason: 'no commit', at: 2 } } },
        { worktreeCleanup: { ...pending().worktreeCleanup, phase: 'kept' as const } },
        {},
      ]) {
        const it_ = await harness({ overrides })
        await it_.flow.cleanUp('s1')
        expect(it_.log).toEqual([])
      }
    })

    it('writes a cleanup result for a session that committed from its split and stopped, labelled by the receipt, and keeps a landed row', async () => {
      const receipt: SvnLabelledRevision = { repository: 'https://svn.test/repos/app', revision: 51, label: 'receipt' }
      const it_ = await harness({ overrides: {
        ...pending(),
        commitReceipts: [{ scopeRoot: worktreeConst, revision: 51, paths: ['a.txt'], at: 3 }],
        worktree: { ...recordOf().worktree!, caller: { tag: 'run-9', notify: { sessionId: 'coordinator', text: 'wake' } } },
      } })
      it_.own.value = [receipt]

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.retiredWorktree).toMatchObject({
        revisions: ['https://svn.test/repos/app:r51'],
        caller: { tag: 'run-9', notify: { sessionId: 'coordinator', text: 'wake' } },
      })
      expect(it_.results.list({ tag: 'run-9' })).toEqual([expect.objectContaining({
        actionId: expect.stringMatching(/^cleanup-[a-f0-9]{64}$/), action: 'cleanup', result: 'committed', removal: 'removed', revisions: [receipt],
        mainCopy: ownerConst, worktreePath: worktreeConst, notify: expect.objectContaining({ state: 'pending' }),
      })])
      expect(it_.record()?.retiredWorktree).toMatchObject({ ownerDir: ownerConst, landed: [receipt] })
      expect(it_.record()?.completed).toBeUndefined()
      expect(it_.ended).toEqual([])
      expect(it_.landedDue).toEqual([ownerConst])
    })

    it('records never-started for a clean worktree without start proof', async () => {
      const h = await harness({ overrides: { ...pending(), worktree: { ...recordOf().worktree!, agentStartedAt: undefined } } })
      await h.flow.cleanUp('s1')
      expect(h.results.list({})).toEqual([expect.objectContaining({ result: 'never-started' })])
    })

    it('writes no result for a worktree that never committed', async () => {
      const it_ = await harness({ overrides: pending('remove-when-ended') })

      await it_.flow.cleanUp('s1')

      expect(it_.own.reads).toBe(1)
      expect(it_.results.list({})).toEqual([])
      expect(it_.ended).toEqual(['s1'])
    })

    it('finishes the result of a Finish whose removal a holder stopped, writes no second result and keeps a landed row', async () => {
      const receipt: SvnLabelledRevision = { repository: 'https://svn.test/repos/app', revision: 51, label: 'receipt' }
      const it_ = await harness({ overrides: pending('removal-unfinished', 'in use') })
      await it_.results.put(WorktreeResultsStore.recordOf({
        actionId: 'finish-1', action: 'finish', result: 'committed', sessionId: 's1', title: '014 - fix login',
        worktreePath: worktreeConst, mainCopy: ownerConst, directoryId: '1:2:3', removal: 'pending', revisions: [receipt],
        lines: ['-> committed app:r51'], logs: [], at: 4_000, caller: undefined,
      }))

      await it_.flow.cleanUp('s1')

      expect(it_.own.reads).toBe(0)
      expect(it_.results.list({})).toEqual([expect.objectContaining({
        actionId: 'finish-1', removal: 'removed', lines: ['-> committed app:r51', '   worktree removed after the session'],
      })])
      expect(it_.record()?.retiredWorktree).toMatchObject({ ownerDir: ownerConst, landed: [receipt] })
      expect(it_.ended).toEqual([])
      expect(it_.landedDue).toEqual([ownerConst])
    })

    describe('a kept Finish that published and whose removal failed past its rename (UA1-J11-3)', () => {
      const receipt: SvnLabelledRevision = { repository: 'https://svn.test/repos/app', revision: 7, label: 'receipt', paths: ['/trunk/a.txt'] }
      const kept = (): Partial<SessionRecord> => ({
        ...pending('requested'),
        worktreeLifecycle: {
          version: 4, actionId: 'finish-1', phase: 'kept', outOfDate: 0, journal: [],
          facts: { worker: { liveness: 'stopped', resumeFailures: 0 } },
          publication: { revisions: [receipt], verified: [receipt], proofs: [], savedActions: ['finish-1'] },
        },
      })

      it('finishes the kept Finish result, writes no second result and keeps a landed row with the publication', async () => {
        const it_ = await harness({ overrides: kept() })
        it_.svn.presentValue = false
        await it_.results.put(WorktreeResultsStore.recordOf({
          actionId: 'finish-1', action: 'finish', result: 'committed', sessionId: 's1', title: '014 - fix login',
          worktreePath: worktreeConst, mainCopy: ownerConst, directoryId: '1:2:3', removal: 'kept', revisions: [receipt],
          lines: ['Worktree kept. Published: app r7'], logs: [], at: 4_000, caller: undefined,
        }))

        await it_.flow.cleanUp('s1')

        expect(it_.results.list({})).toEqual([expect.objectContaining({
          actionId: 'finish-1', result: 'committed', removal: 'removed', lines: ['Worktree kept. Published: app r7', '   worktree removed after the session'],
        })])
        expect(it_.record()?.retiredWorktree).toMatchObject({ ownerDir: ownerConst, landed: [receipt] })
        expect(it_.record()?.completed).toBeUndefined()
        expect(it_.ended).toEqual([])
        expect(it_.landedDue).toEqual([ownerConst])
      })

      it('writes a committed cleanup result from the publication of its lifecycle when no Finish result is left', async () => {
        const it_ = await harness({ overrides: kept() })
        it_.svn.presentValue = false

        await it_.flow.cleanUp('s1')

        expect(it_.results.list({})).toEqual([expect.objectContaining({ action: 'cleanup', result: 'committed', removal: 'removed', revisions: [receipt] })])
        expect(it_.record()?.retiredWorktree).toMatchObject({ ownerDir: ownerConst, landed: [receipt] })
        expect(it_.ended).toEqual([])
        expect(it_.landedDue).toEqual([ownerConst])
      })
    })

    it('removes the session of a Discard whose removal a holder stopped: nothing landed', async () => {
      const it_ = await harness({ overrides: pending('discard-unfinished', 'in use') })
      await it_.results.put(WorktreeResultsStore.recordOf({
        actionId: 'discard-1', action: 'discard', result: 'discarded', sessionId: 's1', title: '014 - fix login',
        worktreePath: worktreeConst, mainCopy: ownerConst, directoryId: '1:2:3', removal: 'pending', revisions: [],
        lines: ['DISCARDED'], logs: [], at: 4_000, caller: undefined,
      }))

      await it_.flow.cleanUp('s1')

      expect(it_.record()?.retiredWorktree?.landed).toBeUndefined()
      expect(it_.ended).toEqual(['s1'])
      expect(it_.landedDue).toEqual([])
    })
  })
})
