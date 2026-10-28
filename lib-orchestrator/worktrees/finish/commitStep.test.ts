import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeLease } from '../worktreeLease'
import type { SvnCommitHistory } from '../../svn/svn.types'
import type { SessionRecord, SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import { SessionScriptsManager } from '../../sessionManager/worktreeSessionScripts'
import { SvnStepRunner } from '../svnStepRunner'
import { WorktreeLifecycleMigration } from '../worktreeLifecycleMigration'
import type { SvnStepJournalEntry } from '../worktreeState'
import { testAssembly } from './finishTestRecords'
import { CommitStep } from './commitStep'
import { FinishProjection } from './finishProjection'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'jamat-commit-step-'))
  directories.push(directory)
  const store = await SessionRecordsStore.load(join(directory, 'records.json'), { snapshotsDirectory: join(directory, 'snapshots'), report: () => {} })
  const selected = join(directory, 'a.txt')
  const action: SessionRecordSvnAction = { kind: 'finish', actionId: 'action', flowVersion: 1, stage: 'committing', root: directory,
    checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1000,
    roots: [{ path: directory, own: '', changed: ['a.txt'], selection: [selected], bounds: { repository: 'url', base: '/trunk', rootBase: 1, since: 1 } }],
    commit: { selection: [selected], hashes: { 'a.txt': 'hash' }, message: '[App] Add a', messageSource: 'person-local' } }
  const record: SessionRecord = { sessionId: 'parent', kind: 'shell', title: 'Tree', directory: { mode: 'default' }, binding: null,
    life: 'live', createdAt: 1, worktree: { kind: 'svn', worktreePath: directory, repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' }, svnAction: action }
  await store.put(record)
  const logs = new ScriptLogStore(join(directory, 'logs'))
  const unreachable = async (): Promise<never> => { throw new Error('Host must not be used') }
  const scripts = new SessionScriptsManager({ records: store, logs, now: () => 1000, report: () => {}, onCollapsed: () => {},
    host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable } })
  let commits = 0
  const runner = new SvnStepRunner({ records: store, scripts, now: () => 2000, newId: () => 'run', changed: () => {},
    svn: { run: async (_cwd, _args, options) => { commits += 1; options?.onStdout?.('Committed revision 2.');
      return { code: 0, stdout: 'Committed revision 2.', stderr: '', failure: null } } } })
  const history: SvnCommitHistory[] = []
  const step = new CommitStep({ records: store, runner, logs, now: () => 2000,
    svn: { logSince: async () => ({ ok: true, value: history }), prepareCommit: async (_scope, paths, beforeAdd) => {
      await beforeAdd?.([...paths])
      const stored = store.get('parent')!
      expect(stored.svnAction?.commit?.preparedAdds).toEqual(paths)
      expect(stored.worktreeLifecycle?.journal[0]).toMatchObject({ kind: 'commit', preparedAdds: paths })
      return { ok: true, value: { targets: [...paths], added: [...paths] } }
    } } })
  return { step, store, history, action, directory, commits: () => commits, record }
}

const intent = (extra: Partial<SvnStepJournalEntry> = {}): SvnStepJournalEntry => ({ stepId: 'action-commit-0', runId: 'run', kind: 'commit', attempt: 1,
  baseRevision: 1, paths: ['/trunk/a.txt'], messageHash: CommitStep.messageHash('[App] Add a'), startedAt: 1000, ...extra })
const revision = (extra: Partial<SvnCommitHistory> = {}): SvnCommitHistory => ({ revision: 2, date: 1500, author: 'ana', message: '[App] Add a', paths: ['/trunk/a.txt'], ...extra })

describe('CommitStep', () => {
  it('recovers a later attempt in the same action without treating its failed predecessor as a competitor', async () => {
    const h = await harness(), retry = intent({ runId: 'retry', attempt: 2 })
    await h.store.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...WorktreeLifecycleMigration.fromOld(record)!,
      journal: [intent({ endedAt: 1100, outcome: 'auth' }), retry] } }))
    h.history.push(revision())
    expect(await h.step.recover(retry, h.directory)).toEqual({ kind: 'landed', revision: 2 })
    expect(h.commits()).toBe(0)
    const other = { ...h.record, sessionId: 'other' }
    await h.store.put({ ...other, worktreeLifecycle: { ...WorktreeLifecycleMigration.fromOld(other)!, journal: [intent({ runId: 'other-run' })] } })
    expect(await h.step.recover(retry, h.directory)).toMatchObject({ kind: 'ambiguous' })
  })
  async function approved() {
    const h = await harness()
    await h.store.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...WorktreeLifecycleMigration.fromOld(record)!, approvedAt: 1, execution: { ...h.action },
      preparation: { format: 1, content: testAssembly().content, metadata: testAssembly().metadata, manifest: 'fixture', commands: testAssembly().content, checks: 'none', checkedAt: 1, attempt: 0 },
      review: { version: 0, selection: ['a.txt'], hashes: { 'a.txt': 'hash' }, message: '[App] Add a', source: 'person-local', acknowledged: [], headMovedBy: 0 } } }))
    let idle = false
    let hash = 'hash'
    let held = false
    const control: Parameters<CommitStep['publish']>[2] = { commands: { lease: new WorktreeLease('test', () => []), verify: async () => { expect(held).toBe(true) } },
      svn: { assembly: async () => ({ ok: true, value: testAssembly() }), commitHashes: async () => ({ ok: true, value: { 'a.txt': hash } }), unprepareCommit: async () => ({ ok: true, value: undefined }) },
      busyReason: () => idle ? null : 'the worker is working', holdInput: () => { held = true; return () => { held = false } } }
    return { ...h, action: FinishProjection.action(h.store.get('parent')!)!, control, idle: () => { idle = true }, edit: () => { hash = 'edited' }, held: () => held }
  }

  it('waits for a fresh idle proof, then holds input through publication', async () => {
    const h = await approved()
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'waiting' })
    expect(h.commits()).toBe(0)
    expect(await h.step.publish('parent', { ...h.action, roots: [{ ...h.action.roots![0], path: 'C:/forged' }] }, h.control)).toEqual({ kind: 'review' })
    expect(await h.step.publish('parent', { ...h.action, roots: [{ ...h.action.roots![0], selection: [] }] }, h.control)).toEqual({ kind: 'review' })
    expect(h.store.get('parent')?.worktreeLifecycle?.awaitingIdleAt).toBe(2000)
    expect(h.store.get('parent')?.worktreeLifecycle?.awaitingIdleReason).toBe('the worker is working')
    h.idle()
    expect(await h.step.publish('parent', h.action, h.control)).toMatchObject({ kind: 'completed', result: { ok: true } })
    expect(h.store.get('parent')?.worktreeLifecycle?.step).toBe('verifying')
    expect(h.store.get('parent')?.worktreeLifecycle?.awaitingIdleReason).toBeUndefined()
    expect(h.held()).toBe(false)
  })

  it('publishes under a busy worker only with the person confirmation of this approval (UA1-J13-1)', async () => {
    const h = await approved()
    const approvedAt = h.store.get('parent')!.worktreeLifecycle!.approvedAt!
    await h.store.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, busyConfirmedFor: approvedAt + 1 } }))
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'waiting' })
    await h.store.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, busyConfirmedFor: approvedAt } }))
    expect(await h.step.publish('parent', h.action, h.control)).toMatchObject({ kind: 'completed', result: { ok: true } })
    expect(h.commits()).toBe(1)
    expect(h.store.get('parent')?.worktreeLifecycle).toMatchObject({ step: 'verifying', busyConfirmedFor: approvedAt })
  })

  it('refuses busy publication even with the old confirmation flag, then rehashes after idle', async () => {
    const h = await approved()
    h.edit()
    await h.store.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      execution: { ...record.worktreeLifecycle!.execution!, confirmBusy: true } } }))
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'waiting' })
    expect(h.commits()).toBe(0)
    h.idle()
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'review' })
    expect(h.commits()).toBe(0)
    expect(h.store.get('parent')?.worktreeLifecycle?.approvedAt).toBeUndefined()
  })

  it('requires fresh review when properties change between preflight and publication', async () => {
    const h = await approved()
    h.idle()
    let reads = 0
    h.control.svn.commitHashes = async () => ({ ok: true, value: { 'a.txt': ++reads === 1 ? 'hash' : 'with-auto-properties' } })
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'review' })
    expect(h.commits()).toBe(0)
    const state = h.store.get('parent')!.worktreeLifecycle!
    expect(state.step).toBe('reviewing')
    expect(state.approvedAt).toBeUndefined()
    expect(state.review?.hashes['a.txt']).toBe('with-auto-properties')
    expect(state.journal).toEqual([expect.objectContaining({ outcome: 'other', recovered: 'not-landed', endedAt: 2000 })])
  })

  it('stops on the first out-of-date result and requires new preparation', async () => {
    const h = await approved()
    h.idle()
    h.history.push(revision())
    vi.spyOn(h.step, 'run').mockResolvedValue({ ok: false, output: 'out of date', exitCode: 1, runId: 'run', failure: 'out-of-date' })
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'repository-busy' })
    expect(h.store.get('parent')?.worktreeLifecycle).toMatchObject({ outOfDate: 1, phase: 'waiting', incoming: [{ revision: 2, author: 'ana' }] })
    expect(h.store.get('parent')?.worktreeLifecycle?.approvedAt).toBeUndefined()
    expect(h.store.get('parent')?.worktreeLifecycle?.preparation).toBeUndefined()
    expect(h.held()).toBe(false)
  })

  it('refuses a mismatched payload and does not repeat a successful publication', async () => {
    const h = await approved()
    h.idle()
    expect(await h.step.publish('parent', { ...h.action, commit: { ...h.action.commit!, message: 'different' } }, h.control)).toEqual({ kind: 'review' })
    expect(h.commits()).toBe(0)
    expect(await h.step.publish('parent', h.action, h.control)).toMatchObject({ kind: 'completed' })
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'review' })
    expect(h.commits()).toBe(1)
  })

  it('cannot overwrite a Keep or newer approval while the selected hashes are read', async () => {
    const h = await approved()
    h.idle()
    h.control.svn.commitHashes = async () => {
      await h.store.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, version: record.worktreeLifecycle!.version + 1, phase: 'kept', step: undefined } }))
      return { ok: true, value: { 'a.txt': 'changed' } }
    }
    expect(await h.step.publish('parent', h.action, h.control)).toEqual({ kind: 'review' })
    expect(h.commits()).toBe(0)
    expect(h.store.get('parent')?.worktreeLifecycle?.phase).toBe('kept')
  })

  it('records the prepared target intent and runs the commit without staging', async () => {
    const h = await harness()
    expect(await h.step.run('parent', h.action)).toMatchObject({ ok: true, output: 'Committed revision 2.' })
    expect(h.commits()).toBe(1)
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[0]).toMatchObject({ outcome: 'ok', paths: ['/trunk/a.txt'] })
  })

  it('finds the landed revision without executing another commit, including closed intent evidence', async () => {
    const h = await harness(); h.history.push(revision())
    expect(await h.step.recover(intent(), h.directory)).toEqual({ kind: 'landed', revision: 2 })
    expect(await h.step.recover(intent({ endedAt: 1600, outcome: 'ok' }), h.directory)).toEqual({ kind: 'landed', revision: 2 })
    expect(h.commits()).toBe(0)
  })

  it('recovers a closed intent independently of server clock skew', async () => {
    const h = await harness()
    h.history.push(revision({ date: 61_700 }))
    expect(await h.step.recover(intent({ endedAt: 1600, outcome: 'ok' }), h.directory)).toEqual({ kind: 'landed', revision: 2 })
  })

  it('requires matching paths and known author, without using local time as negative evidence', async () => {
    const h = await harness()
    h.history.push(revision({ paths: ['/other/a.txt'] }), revision({ author: 'other' }))
    expect(await h.step.recover(intent({ author: 'ana' }), h.directory)).toEqual({ kind: 'not-landed' })
    h.history.push(revision({ date: 500_000 }))
    expect(await h.step.recover(intent({ author: 'ana' }), h.directory)).toEqual({ kind: 'landed', revision: 2 })
  })

  it('normalizes repository root paths and refuses a revision with additional changed paths', async () => {
    const h = await harness()
    h.history.push(revision({ paths: ['/'] }))
    expect(await h.step.recover(intent({ paths: [''] }), h.directory)).toEqual({ kind: 'landed', revision: 2 })
    h.history.splice(0, 1, revision({ paths: ['/trunk/a.txt', '/unexpected.txt'] }))
    expect(await h.step.recover(intent(), h.directory)).toMatchObject({ kind: 'ambiguous', candidates: [2] })
    h.history.length = 0
    expect(await h.step.recover(intent({ revision: 2 }), h.directory)).toMatchObject({ kind: 'ambiguous', candidates: [] })
  })

  it('waits when two revisions or two worktrees can claim the same publication', async () => {
    const h = await harness(); h.history.push(revision(), revision({ revision: 3 }))
    expect(await h.step.recover(intent(), h.directory)).toMatchObject({ kind: 'ambiguous', candidates: [2, 3] })
    h.history.pop()
    const other = { ...h.record, sessionId: 'other', worktree: { ...h.record.worktree!, worktreePath: 'C:/other' } }
    await h.store.put({ ...other, worktreeLifecycle: { ...WorktreeLifecycleMigration.fromOld(other)!, journal: [intent({ runId: 'other-run' })] } })
    expect(await h.step.recover(intent(), h.directory)).toMatchObject({ kind: 'ambiguous', reason: expect.stringContaining('Another worktree'), candidates: [2] })
  })

  it('deduplicates receipts by normalized scope and revision', async () => {
    const h = await harness()
    await h.step.receipt('parent', h.directory, 2, ['a.txt'])
    await h.step.receipt('parent', h.directory, 2, ['a.txt'])
    await h.step.receipt('parent', 'C:/another', 2, ['a.txt'])
    expect(h.store.get('parent')?.commitReceipts).toHaveLength(2)
  })
})
