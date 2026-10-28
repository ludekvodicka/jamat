import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finishTestRecords, emptyUpdateTargets } from './finish/finishTestRecords'
import { WorktreeUpdate } from './worktreeUpdate'
import { WorktreeStateValidation } from './worktreeStateValidation'
import type { SvnUpdateSnapshot, SvnUpdateTarget } from '../svn/svnUpdateTargets'

async function harness() {
  const h = await finishTestRecords()
  const root = h.records.get('worker')!.worktree!.worktreePath
  const target = (name: string, revision: number): SvnUpdateTarget => ({ path: join(root, name), revision,
    url: `https://svn.test/${name || 'app'}`, repository: 'https://svn.test', kind: 'dir', pinned: false })
  const library = target('library', 8), next = target('next', 12)
  let conflict = false, reject: string | undefined, changed = false
  const commands: Array<{ cwd: string; args: string[] }> = []
  const snapshots = new Map<string, SvnUpdateSnapshot>([[root, { properties: {}, localMappingChanges: false, children: [library, next], missing: [], mismatched: [] }]])
  const deps: ConstructorParameters<typeof WorktreeUpdate>[0] = {
    records: h.records, changed: () => {},
    svn: { conflictSet: async () => ({ ok: true, value: { revision: 2, rows: [], facts: conflict ? [{ path: 'library/a', kind: 'text',
      takesArgument: true, tree: null, sidecars: [], properties: [], content: { binary: false, unreadable: false, equal: 'differs' } }] : [] } }) },
    targets: { owner: async (_root, revision) => target('', revision),
      verify: vi.fn(async () => {}), snapshot: async (item, discover = true) => {
        const snapshot = structuredClone(snapshots.get(item.path) ?? await emptyUpdateTargets.snapshot(item))
        if (!discover) snapshot.children = []
        if (changed && item.path === root) snapshot.properties = { [root]: 'definition' }
        return snapshot
      } },
    runner: { run: vi.fn(async (_id, kind, cwd, args) => {
      commands.push({ cwd, args })
      if (kind === 'update' && cwd === reject) throw new Error('network interrupted')
      return { ok: true as const, output: '', exitCode: 0, runId: `run-${commands.length}` }
    }) },
  }
  return { ...h, root, target, library, next, commands, deps, update: new WorktreeUpdate(deps), snapshots,
    conflict: (value: boolean) => { conflict = value }, reject: (value?: string) => { reject = value }, changed: () => { changed = true } }
}

describe('WorktreeUpdate', () => {
  it('gives an explicit retry a new command identity without changing saved targets or replaying completed roots', async () => {
    const h = await harness()
    h.reject(h.next.path)
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
    const before = structuredClone(h.records.get('worker')!.worktreeLifecycle!.update!)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, stoppedFailure: 'two failures' } }))
    await h.update.retry('worker')
    const state = h.records.get('worker')!.worktreeLifecycle!
    expect(state.stoppedFailure).toBeUndefined()
    expect(state.update!.generation).not.toBe(before.generation)
    expect({ ...state.update, generation: before.generation }).toEqual(before)
    h.reject()
    await h.update.run('worker', 'finish', h.root, 99)
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path, h.next.path, h.next.path])
  })

  it.each([{ cursor: 8 }, { units: [{ phase: 'future' }] }, { completed: true }])('retains the journal and refuses writes for an unreadable saved cursor %j', async (patch) => {
    const h = await harness()
    h.reject(h.library.path)
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
    const state = h.records.get('worker')!.worktreeLifecycle!
    const journal = [{ stepId: 'retained', kind: 'update' as const, attempt: 1, runId: 'lost', startedAt: 1 }]
    const unreadable = { ...state, journal, update: { ...state.update, ...patch } }
    expect(WorktreeStateValidation.parse(unreadable)).toBeUndefined()
    const commands = h.commands.length
    await expect(h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: unreadable as typeof state }))).rejects.toThrow('worktreeLifecycle is malformed')
    expect(h.commands).toHaveLength(commands)
  })

  it('refuses changed carrier definitions before resuming a saved external', async () => {
    const h = await harness()
    h.reject(h.library.path)
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
    h.changed(); h.reject()
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('External definitions changed')
    expect(h.commands).toHaveLength(2)
    expect(h.records.get('worker')?.worktreeLifecycle?.update?.cursor).toBe(1)
  })

  it.each([false, true])('recovers a lost reply with cleanup only for a worktree (main=%s)', async (main) => {
    const h = await harness()
    h.reject(h.library.path)
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
    const state = h.records.get('worker')!.worktreeLifecycle!.update!
    const entry = { stepId: `finish-update-${state.generation}-1`, kind: 'update' as const, attempt: 1,
      targetRevision: 8, cwd: h.library.path, startedAt: 1, runId: 'interrupted' }
    await h.records.update('worker', (record) => ({ ...record,
      worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [entry] } }))
    const count = h.commands.length
    expect(await h.update.recover('worker', { ...entry, targetRevision: 9 }, main)).toBe(false)
    expect(h.commands).toHaveLength(count)
    expect(await h.update.recover('worker', entry, main)).toBe(true)
    expect(h.commands).toHaveLength(count + (main ? 0 : 1))
    expect(h.records.get('worker')?.worktreeLifecycle?.journal[0].endedAt).toBeDefined()
    expect(h.records.get('worker')?.worktreeLifecycle?.update?.cursor).toBe(1)
  })

  it('resumes the failed external at its saved revision after reloading, without updating completed roots again', async () => {
    const h = await harness()
    h.reject(h.next.path)
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
    const records = await h.reload()
    expect(records.get('worker')?.worktreeLifecycle?.update).toMatchObject({ cursor: 2, completed: false })
    h.reject()
    const resumed = new WorktreeUpdate({ ...h.deps, records })
    expect(await resumed.run('worker', 'finish', h.root, 99)).toMatchObject({ complete: true, revision: 2 })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path, h.next.path, h.next.path])
    expect(h.commands.at(-1)?.args).toContain('12')
    expect(h.commands.every((row) => row.args.includes('--ignore-externals'))).toBe(true)
  })

  it('waits after a conflicting root and resumes at verification before touching any later external', async () => {
    const h = await harness()
    h.conflict(true)
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: false })
    expect(h.commands).toHaveLength(1)
    h.conflict(false)
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: true })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path, h.next.path])
  })

  it('goes on to later externals past a conflict svn held before the update, and still waits on a new one', async () => {
    const h = await harness()
    h.conflict(true)
    expect(await h.update.run('worker', 'update-main', h.root, 2, ['elsewhere'])).toMatchObject({ complete: false })
    expect(h.commands).toHaveLength(1)
    expect(await h.update.run('worker', 'update-main', h.root, 2, ['library/a'])).toMatchObject({ complete: true })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path, h.next.path])
    expect(h.deps.targets.verify).toHaveBeenCalledWith(expect.objectContaining({ path: h.root }), true, [join(h.root, 'library/a')])
  })

  it('reconciles a missing mount through native SVN before independent external updates', async () => {
    const h = await harness()
    h.snapshots.get(h.root)!.missing = [h.library.path]
    const run = h.deps.runner.run
    h.deps.runner.run = async (...args) => {
      const result = await run(...args)
      if (!args[3].includes('--ignore-externals')) h.snapshots.get(h.root)!.missing = []
      return result
    }
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.root, h.library.path, h.next.path])
    expect(h.commands[1].args).not.toContain('--ignore-externals')
  })

  it('does not silently repair a switched external whose definition has not changed', async () => {
    const h = await harness()
    h.snapshots.get(h.root)!.mismatched = [h.library.path]
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('unchanged definition')
    expect(h.commands).toHaveLength(1)
  })

  it('updates file externals through their carrier and verifies their own revision without a direct file UPDATE', async () => {
    const h = await harness()
    h.library.kind = 'file'; h.library.pinned = true
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands.map((call) => call.cwd)).toEqual([h.root, h.root, h.next.path])
    expect(h.commands[1].args).not.toContain('--ignore-externals')
    expect(h.deps.targets.verify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', revision: 8, pinned: true }))
  })

  it('forgets the incoming change a refused publication found only when an update completes', async () => {
    const h = await harness()
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      knownIncoming: { paths: ['library/version.txt'], at: 1 } } }))
    h.reject(h.next.path)
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
    expect(h.records.get('worker')!.worktreeLifecycle!.knownIncoming).toEqual({ paths: ['library/version.txt'], at: 1 })
    h.reject()
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.records.get('worker')!.worktreeLifecycle!.knownIncoming).toBeUndefined()
  })

  it('requires verification before advancing the saved cursor', async () => {
    const h = await harness()
    h.deps.targets.verify = async (_target, revision = true) => { if (revision) throw new Error('Skipped obstructed target') }
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('Skipped obstructed target')
    expect(h.records.get('worker')?.worktreeLifecycle?.update).toMatchObject({ cursor: 0, completed: false, units: [{ phase: 'updated' }] })
  })
})
