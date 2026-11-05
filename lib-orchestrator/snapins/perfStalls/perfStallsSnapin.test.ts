import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerfBuild, PerfRecord } from '../../perfMonitor/perfRecord.types'
import type { SessionInfo, WorktreeResultDto } from '../../sessionManager/sessionManagerApi.types'
import { SessionNumberView } from '../../sessionManager/sessionNumberView'
import { newestOf } from '../shared/attemptState'
import type { AttemptRecord, SnapinContext, SnapinItem, SnapinStateDocument } from '../shared/snapinContract'
import { PerfStallsSnapin } from './perfStallsSnapin'

const at = Date.UTC(2026, 10, 2, 12)
const build: PerfBuild = { version: '3.10.0', inputHash: 'a'.repeat(64), builtAt: new Date(at - 3_600_000).toISOString() }
let root: string
function context(): SnapinContext {
  return { log: vi.fn(), now: () => at + 120_000, projects: { projects: async () => [] },
    svn: { urlOf: vi.fn(async () => ({ ok: true as const, value: 'https://svn/project' })), listAtHead: async () => ({ ok: true, value: [] }),
      changedNames: async () => ({ ok: true, value: [] }) },
    sessions: { snapshot: vi.fn(() => ({ revision: 0, reconciled: true, sessions: [], categories: [], orphans: [],
      host: { presence: 'running' as const, hostVersion: null, hostInstanceId: null, liveCount: 0, lastStartError: null } })),
      versioningMode: () => 'checkpoints', openTerminal: async () => 'ok', createSession: async () => { throw new Error('Unexpected create') },
      worktreeResults: vi.fn(async () => ({ ok: true as const, value: { results: [] } })), acknowledgeWorktreeResult: async actionId => ({ ok: true, value: { actionId } }) } }
}
async function records(identity = build) {
  const base = { v: 1 as const, at, process: 'main' as const, pid: 1, build: identity }
  const rows: PerfRecord[] = [{ ...base, kind: 'sample', elu: 0.1, loopP50: null, loopP99: null, loopMax: null, heapMb: null },
    { ...base, kind: 'span', name: 'records.commit', ms: 100, selfMs: 40, depth: 0, blocking: true },
    { ...base, kind: 'profile', profileId: 'measured.cpuprofile', trigger: 'elu' }]
  await writeFile(join(root, 'main-2026-11-02.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'))
  await writeFile(join(root, 'machine-2026-11-02.jsonl'), JSON.stringify({ ...base, process: 'machine', kind: 'machine', cpu: 0.2, jamatCpu: null }))
}
function source(identity = build) { return new PerfStallsSnapin({ directories: [root], clientBuild: identity, hostProcess: () => null }) }
async function listed(snapin = source(), values = { targetProjectDirectory: root }): Promise<SnapinItem[]> {
  const answer = await snapin.list(context(), values)
  if (!answer.ok) throw new Error(answer.detail)
  return answer.items
}
const attempt = (itemKey: string): AttemptRecord => ({ attemptId: '1234abcd-test', itemKey, title: 'Performance', mode: 'wt',
  projectDirectory: 'project', agentId: 'claude', phase: 'review', createdAt: at, appliedThrough: 0, group: 'project', leaseHeld: false, sessionId: 's' })
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'perf-snapin-')); await records() })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('Perf stalls source', () => {
  it('lists over-threshold clusters, holds an empty target and omits under-threshold work', async () => {
    const ctx = context(), snapin = source()
    const answer = await snapin.list(ctx, {})
    expect(answer).toMatchObject({ ok: true, items: [{ mode: 'wt', selectable: false, hold: 'Set the target project directory in Settings > Snap-ins' }] })
    expect(ctx.svn.urlOf).not.toHaveBeenCalled()
    expect(await snapin.list(ctx, { targetProjectDirectory: root, selfMsPerActiveHour: 3_000 })).toEqual({ ok: true, items: [] })
    expect((await listed())[0]).toMatchObject({ selectable: true, payload: { selfMs: 40, selfMsPerActiveHour: 2400 } })
  })

  it('launches an SVN worktree with the measured cluster, profile and rebuild/re-measure instruction', async () => {
    const snapin = source(), ctx = context(), item = (await listed())[0]!
    const spec = await snapin.launchSpec(ctx, { targetProjectDirectory: root }, item, '1234abcd-test')
    expect(spec).toMatchObject({ directory: { mode: 'adHoc', path: root }, worktreeSlug: '1234abcd',
      work: { kind: 'perf-stall', process: 'main', name: 'records.commit', build, selfMs: 40, profileId: 'measured.cpuprofile' } })
    if ('hold' in spec) throw new Error(spec.hold)
    expect(spec.work.instruction).toContain('rebuilt client')
    expect(spec.work.instruction).toContain('measure again with jamat-cli perf report')
    expect(spec.promptTemplate).toContain('--kind started')
    expect(spec.promptTemplate).toContain('--outcome ready --detail-file')
    expect(spec.promptTemplate).toContain('Stop at ready for human Finish')
    expect(spec.promptTemplate).toContain('Do not invoke or imitate PP pass mode')
    expect(ctx.svn.urlOf).toHaveBeenCalledExactlyOnceWith(root)
    const highest = await snapin.launchSpec(ctx, { targetProjectDirectory: root }, item, 'ffffffff-ffff-ffff-ffff-ffffffffffff')
    if ('hold' in highest) throw new Error(highest.hold)
    expect(highest.number).toBe('p48575')
    expect(SessionNumberView.isSelectorNumber(highest.number)).toBe(true)
    expect(snapin.settings.validate({ targetProjectDirectory: 'relative' })).toContain('absolute')
    expect(snapin.settings.validate({ maxSpanMs: -1 })).toContain('thresholds')
  })

  it('accepts configured separators and junctions matching the resolved listed directory', async () => {
    const target = join(root, 'project')
    const alias = join(root, 'project-alias')
    await mkdir(target)
    await symlink(target, alias, 'junction')
    const snapin = source()
    for (const configured of [target.replace(/\\/g, '/'), alias]) {
      const ctx = context()
      const item = (await listed(snapin, { targetProjectDirectory: configured }))[0]!
      item.projectDirectory = await realpath(item.projectDirectory)
      const spec = await snapin.launchSpec(ctx, { targetProjectDirectory: configured }, item, '1234abcd-test')
      expect(spec).toMatchObject({ directory: { mode: 'adHoc', path: configured }, worktreeSlug: '1234abcd' })
      expect(ctx.svn.urlOf).toHaveBeenCalledExactlyOnceWith(configured)
    }
  })

  it('refuses a different target or a retargeted junction before checking SVN', async () => {
    const target = join(root, 'project')
    const other = join(root, 'other')
    const alias = join(root, 'project-alias')
    await mkdir(target)
    await mkdir(other)
    await symlink(target, alias, 'junction')
    const snapin = source(), ctx = context()
    const item = (await listed(snapin, { targetProjectDirectory: alias }))[0]!
    item.projectDirectory = await realpath(item.projectDirectory)
    expect(await snapin.launchSpec(ctx, { targetProjectDirectory: other }, item, '1234abcd-test'))
      .toEqual({ hold: 'Target changed; refresh the performance listing' })
    await rm(alias, { recursive: true })
    await symlink(other, alias, 'junction')
    expect(await snapin.launchSpec(ctx, { targetProjectDirectory: alias }, item, '1234abcd-test'))
      .toEqual({ hold: 'Target changed; refresh the performance listing' })
    expect(ctx.svn.urlOf).not.toHaveBeenCalled()
  })

  it('holds an unavailable configured target before checking SVN', async () => {
    const snapin = source(), ctx = context(), item = (await listed())[0]!
    item.projectDirectory = await realpath(item.projectDirectory)
    expect(await snapin.launchSpec(ctx, { targetProjectDirectory: join(root, 'missing') }, item, '1234abcd-test'))
      .toEqual({ hold: expect.stringContaining('ENOENT') })
    expect(ctx.svn.urlOf).not.toHaveBeenCalled()
  })

  it('retains completed identity for the same input hash and opens a new key for newer different input', async () => {
    const first = (await listed())[0]!
    const completed = { ...attempt(first.key), phase: 'completed' as const }
    const doc: SnapinStateDocument = { schemaVersion: 1, kind: 'perfStalls', paused: false, queue: [], attempts: [completed] }
    const rebuilt = { ...build, builtAt: new Date(at).toISOString() }
    await records(rebuilt)
    const repeated = (await listed(source(rebuilt)))[0]!
    expect(repeated.key).toBe(first.key)
    expect(newestOf(doc, repeated.key)?.phase).toBe('completed')
    const newer = { ...rebuilt, inputHash: 'b'.repeat(64), builtAt: new Date(at + 1).toISOString() }
    await records(newer)
    const fresh = (await listed(source(newer)))[0]!
    expect(fresh.key).not.toBe(first.key)
    expect(newestOf(doc, fresh.key)).toBeUndefined()
  })

  it('uses tagged terminal worktree evidence, distinguishing publication and discard', async () => {
    const snapin = source(), ctx = context(), job = attempt((await listed())[0]!.key)
    const session: SessionInfo = { sessionId: 's', callerOperationId: job.attemptId, kind: 'agent', title: 'Test',
      titleParts: { number: 'p1', name: 'Test' }, tabTitle: 'Test', directory: { mode: 'adHoc', path: root },
      project: { kind: 'adHoc', path: root }, life: 'ended', activity: 'idle', admits: [],
      worktreeView: { version: 1, phase: 'landed', outOfDate: 0, conflicts: 0, summary: '' } }
    vi.mocked(ctx.sessions.snapshot).mockReturnValue({ ...ctx.sessions.snapshot(), sessions: [session] })
    const result: WorktreeResultDto = { actionId: 'a', action: 'finish', result: 'committed', sessionId: 's', title: 'Test', tag: job.attemptId,
      worktreePath: 'wt', mainCopy: root, directoryId: null, removal: 'removed', revisions: [], lines: [], logs: [], notify: null,
      holdsLanded: null, mainUpdating: false, at, acknowledgedAt: null }
    vi.mocked(ctx.sessions.worktreeResults).mockResolvedValue({ ok: true, value: { results: [result] } })
    expect(await snapin.evidence(ctx, job)).toEqual({ published: true, detail: 'Performance worktree landed' })
    session.worktreeView!.phase = 'waiting'
    expect(await snapin.evidence(ctx, job)).toEqual({ published: false })
    session.worktreeView!.phase = 'removed'
    result.result = 'discarded'
    expect(await snapin.evidence(ctx, job)).toEqual({ discarded: true })
    result.tag = 'foreign'
    expect(await snapin.evidence(ctx, job)).toEqual({ published: false })
  })
})
