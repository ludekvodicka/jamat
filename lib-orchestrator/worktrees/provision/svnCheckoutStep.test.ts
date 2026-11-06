import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { ScriptLogStore, SessionScriptsManager } from '../../sessionManager/worktreeSessionScripts'
import type { SvnResult } from '../../svn/svn.types'
import { SvnWorktreeSeed } from '../../svn/svnWorktreeSeed'
import { SvnStepRunner } from '../svnStepRunner'
import { WorktreeLifecycleMigration } from '../worktreeLifecycleMigration'
import { SvnCheckoutStep } from './svnCheckoutStep'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

type Copy = Awaited<ReturnType<SvnWorktreeSeed['copyInto']>>

/**
 * The checkout step of a reserved worktree at r42 over a scripted svn: the runner's commands, the
 * seed's answers and the manager's proof are fixtures, so each case says only what it changes.
 */
async function harness(options: { copy?: Copy; proof?: string | null; update?: 'ok' | 'failed'; interrupted?: boolean; workingCopy?: boolean
  checkoutMilliseconds?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jamat-svn-checkout-step-'))
  directories.push(directory)
  const records = await SessionRecordsStore.load(join(directory, 'records.json'), { snapshotsDirectory: join(directory, 'snapshots'), report: () => {} })
  const logs = new ScriptLogStore(join(directory, 'logs'))
  const unreachable = async (): Promise<never> => { throw new Error('Host must not run checkout') }
  const scripts = new SessionScriptsManager({ records, logs, now: () => 5000, report: () => {}, onCollapsed: () => {},
    host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable } })
  const worktreePath = join(directory, 'owner', '.worktrees', '014-fix')
  const worktree = { kind: 'svn' as const, worktreePath, repositoryRoot: join(directory, 'owner'), branch: 'url', baseCommit: 'r42', directoryId: 'reserved' }
  const step = { key: 'checkout', scriptId: 'svn' as const, name: 'checkout', commands: [], process: { tool: 'svn' as const, cwd: worktreePath, args: ['checkout', '--', 'url@42', '.'] } }
  const parent: SessionRecord = { sessionId: 'parent', kind: 'shell', title: 'Tree', directory: { mode: 'default' }, binding: null,
    life: 'starting', createdAt: 1, worktree, pendingSetup: { local: true, setupSessionId: 'wait', steps: [step], cursor: 0 } }
  await records.put({ ...parent, worktreeLifecycle: WorktreeLifecycleMigration.fromOld(parent)! })
  let clock = 0
  const svnCalls: string[][] = []
  const runner = new SvnStepRunner({ records, scripts, now: () => 5000, newId: (() => { let id = 0; return () => `run-${++id}` })(), changed: () => {},
    svn: { run: async (_cwd, args) => {
      svnCalls.push(args)
      if (args[0] === 'checkout') clock += options.checkoutMilliseconds ?? 100
      const failed = args[0] === 'update' && options.update === 'failed'
      return { code: failed ? 1 : 0, stdout: failed ? 'svn: E170013: Unable to connect' : 'At revision 42.', stderr: '', failure: null }
    } } })
  const seedCalls: string[] = []
  const purges: string[] = []
  const seed: Pick<SvnWorktreeSeed, 'interrupted' | 'copyInto' | 'proof' | 'adopt' | 'refreshLater'> = {
    interrupted: async () => { seedCalls.push('interrupted'); return options.interrupted ?? false },
    copyInto: async (target) => { seedCalls.push(`copy ${target.url}`); return options.copy ?? { ok: false, code: 'refused', detail: 'there is no seed' } },
    proof: async (_root, revision) => { seedCalls.push(`proof r${revision}`); return options.proof ?? null },
    adopt: async (source) => { seedCalls.push(`adopt r${source.revision}`); return { ok: true, value: undefined } },
    refreshLater: () => { seedCalls.push('refresh') },
  }
  const checkout = new SvnCheckoutStep({ records, runner, seed, now: () => clock, svn: {
    reservedCheck: async () => ({ ok: true, value: { workingCopy: (options.workingCopy ?? false) && purges.length === 0 } }),
    status: async () => ({ ok: true, value: { textConflicts: [], otherConflicts: [], changed: [] } }),
    revisionOf: async () => ({ ok: true, value: 42 }),
    purgeReserved: async (location): Promise<SvnResult<void>> => { purges.push(location.directoryId ?? 'none'); return { ok: true, value: undefined } },
  } })
  const logOf = async (runId: string): Promise<string> => (await logs.read('parent', runId, 10_000))?.text ?? ''
  return { checkout, records, svnCalls, seedCalls, purges, logOf }
}

const seeded: Copy = { ok: true, value: { seed: 'C:/owner/.worktrees/.seed', revision: 40, milliseconds: 3000 } }

describe('lib-orchestrator/worktrees/provision/svnCheckoutStep', () => {
  it('copies the seed, updates the copy to the reserved revision under the wait id, proves it and refreshes the seed', async () => {
    const h = await harness({ copy: seeded })
    expect(await h.checkout.run('parent', false)).toBe('wait')
    expect(h.svnCalls).toEqual([['update', '-r', '42', '--accept', 'postpone', '--', '.']])
    expect(h.seedCalls).toEqual(['interrupted', 'copy url', 'proof r42', 'refresh'])
    expect(h.purges).toEqual([])
    const journal = h.records.get('parent')!.worktreeLifecycle!.journal
    expect(journal).toMatchObject([{ kind: 'update', stepId: 'checkout-checkout', targetRevision: 42, outcome: 'ok' }])
    expect(h.records.get('parent')!.scriptRuns?.at(-1)).toMatchObject({ title: 'Checkout from the seed', phase: 'before', outcome: 'succeeded' })
    expect(await h.logOf('wait')).toContain('Copied the seed C:/owner/.worktrees/.seed at r40 in 3.0 s; updating it to r42.')
  })

  it('checks out plainly when the seed does not serve, naming why, and leaves the folder alone', async () => {
    const h = await harness()
    expect(await h.checkout.run('parent', false)).toBe('wait')
    expect(h.svnCalls).toEqual([['checkout', '--', 'url@42', '.']])
    expect(h.purges).toEqual([])
    expect(h.seedCalls).toEqual(['interrupted', 'copy url'])
    expect(await h.logOf('wait')).toContain('Plain checkout; the seed was not used: there is no seed')
  })

  it.each([
    ['a failed copy', { copy: { ok: false, code: 'io-failed', detail: 'disk full' } as Copy }, /disk full/],
    ['a copy that does not prove clean', { copy: seeded, proof: 'svn status names node_modules' }, /no clean checkout at r42: svn status names node_modules/],
    ['a failed update of the copy', { copy: seeded, update: 'failed' as const }, /its update failed: svn: E170013/],
  ])('empties the folder by its identity after %s and checks out plainly', async (_name, options, reason) => {
    const h = await harness(options)
    const runId = await h.checkout.run('parent', false)
    expect(h.purges).toEqual(['reserved'])
    expect(h.svnCalls.at(-1)).toEqual(['checkout', '--', 'url@42', '.'])
    expect(h.seedCalls).not.toContain('refresh')
    expect(await h.logOf(runId)).toMatch(reason)
    expect(h.records.get('parent')!.worktreeLifecycle!.journal.at(-1)).toMatchObject({ kind: 'checkout', outcome: 'ok' })
  })

  it('discards a seed copy that never finished instead of recovering it as a checkout', async () => {
    const h = await harness({ interrupted: true, workingCopy: true, copy: seeded })
    await h.checkout.run('parent', true)
    expect(h.purges).toEqual(['reserved'])
    expect(h.svnCalls).toEqual([['update', '-r', '42', '--accept', 'postpone', '--', '.']])
    expect(h.svnCalls.some((args) => args[0] === 'cleanup')).toBe(false)
  })

  it.each([[1_999, []], [2_000, ['adopt r42']]] as const)('a plain checkout of %d ms makes the seed: %j', async (milliseconds, adopted) => {
    const h = await harness({ checkoutMilliseconds: milliseconds })
    await h.checkout.run('parent', false)
    expect(h.seedCalls.filter((call) => call.startsWith('adopt'))).toEqual(adopted)
    expect(SvnWorktreeSeed.adoptMillisecondsConst).toBe(2_000)
  })
})
