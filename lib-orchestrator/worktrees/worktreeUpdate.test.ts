import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finishTestRecords, emptyUpdateTargets } from './finish/finishTestRecords'
import { WorktreeUpdate } from './worktreeUpdate'
import { WorktreeStateValidation } from './worktreeStateValidation'
import type { SvnUpdateSnapshot, SvnUpdateTarget } from '../svn/svnUpdateTargets'
import type { SvnConflictFact, SvnMountState } from '../svn/svn.types'
import { PathCompare } from '../shared/pathCompare'

async function harness() {
  const h = await finishTestRecords()
  const root = h.records.get('worker')!.worktree!.worktreePath
  const target = (name: string, revision: number): SvnUpdateTarget => ({ path: join(root, name), revision,
    url: `https://svn.test/${name || 'app'}`, repository: 'https://svn.test', kind: 'dir', pinned: false })
  const library = target('library', 8), next = target('next', 12)
  let conflict = false, reject: string | undefined, changed = false
  // Where svn marks the conflict, and which command reports it in its output (every one by default).
  let fact: { path: string; kind: 'text' | 'property' | 'tree'; in?: string; properties?: string[] } = { path: 'library/a', kind: 'text' }
  const commands: Array<{ cwd: string; args: string[] }> = []
  const notes: Array<{ title: string; text: string; stepId: string }> = []
  const snapshots = new Map<string, SvnUpdateSnapshot>([[root, { properties: {}, localMappingChanges: false, children: [library, next], missing: [], mismatched: [] }]])
  // What the round's read of the mounts finds; empty proves nothing, so every mount updates.
  const mounts = new Map<string, SvnMountState>()
  const deps: ConstructorParameters<typeof WorktreeUpdate>[0] = {
    records: h.records, changed: () => {},
    svn: { conflictSet: vi.fn(async () => ({ ok: true as const, value: { revision: 2, rows: [], facts: conflict ? [{ path: fact.path, kind: fact.kind,
      takesArgument: true, tree: null, sidecars: [], properties: (fact.properties ?? []).map((name) => ({ name, older: null, mine: null, theirs: null })), content: { binary: false, unreadable: false, equal: 'differs' as const } } as SvnConflictFact] : [] } })),
      mountStates: vi.fn(async () => ({ ok: true as const, value: new Map([...mounts].map(([path, state]) => [PathCompare.comparable(path), structuredClone(state)])) })) },
    targets: { owner: async (_root, revision) => target('', revision),
      verify: vi.fn(async () => {}), snapshot: vi.fn(async (item: SvnUpdateTarget, discover = true) => {
        const snapshot = structuredClone(snapshots.get(item.path) ?? await emptyUpdateTargets.snapshot(item))
        if (!discover) snapshot.children = []
        if (changed && item.path === root) snapshot.properties = { [root]: 'definition' }
        return snapshot
      }) },
    runner: { run: vi.fn(async (_id, kind, cwd, args) => {
      commands.push({ cwd, args })
      if (kind === 'update' && cwd === reject) throw new Error('network interrupted')
      // svn 1.14 exits 0 with postponed conflicts and names them in its summary.
      const output = conflict && (fact.in === undefined || fact.in === cwd) ? "Updating '.':\nC    library/a\nUpdated to revision 2.\nSummary of conflicts:\n  Text conflicts: 1\n" : "Updating '.':\nAt revision 2.\n"
      return { ok: true as const, output, exitCode: 0, runId: `run-${commands.length}` }
    }), note: vi.fn(async (_id, _kind, _cwd, intent, title, text) => {
      notes.push({ title, text, stepId: intent.stepId })
      return `note-${notes.length}`
    }) },
  }
  /** A mount the round's read sees exactly at `item`'s target, changed by `patch`. */
  const at = (item: SvnUpdateTarget, patch: Partial<SvnMountState> = {}): void => {
    mounts.set(item.path, { path: item.path, url: item.url, repository: item.repository, base: item.revision, missing: false, switched: false,
      skipped: false, localChanges: false, propertyChanges: false, carrier: false, ...patch })
  }
  return { ...h, root, target, library, next, commands, notes, mounts, at, deps, update: new WorktreeUpdate(deps), snapshots,
    conflict: (value: boolean) => { conflict = value }, conflictAt: (value: typeof fact) => { conflict = true; fact = value }, reject: (value?: string) => { reject = value }, changed: () => { changed = true } }
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

  // Worker-agent 031: a sync met conflicts under one action, Finish took another, and Try again kept refusing.
  it('starts again for a new action over an update an earlier action left with no svn command open', async () => {
    const h = await harness()
    h.conflict(true)
    expect(await h.update.run('worker', 'sync', h.root, 2)).toMatchObject({ complete: false })
    h.conflict(false)
    expect(await h.update.run('worker', 'finish', h.root, 3)).toMatchObject({ complete: true, revision: 3 })
    expect(h.records.get('worker')!.worktreeLifecycle!.update).toMatchObject({ actionId: 'finish', revision: 3, completed: true })
  })

  it('refuses a new action while an svn command of the earlier unfinished update is open', async () => {
    const h = await harness()
    h.conflict(true)
    await h.update.run('worker', 'sync', h.root, 2)
    const stale = h.records.get('worker')!.worktreeLifecycle!.update!
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      journal: [{ stepId: `sync-update-${stale.generation}-0`, kind: 'update', attempt: 1, runId: 'lost', startedAt: 1 }] } }))
    const commands = h.commands.length
    await expect(h.update.run('worker', 'finish', h.root, 3)).rejects.toThrow('An unfinished update belongs to another action or working copy')
    expect(h.commands).toHaveLength(commands)
  })

  it('refuses an unfinished update of another working copy', async () => {
    const h = await harness()
    h.conflict(true)
    await h.update.run('worker', 'sync', h.root, 2)
    await expect(h.update.run('worker', 'finish', join(h.root, 'other'), 3)).rejects.toThrow('An unfinished update belongs to another action or working copy')
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

  it('reads the conflicts of the whole tree only after an update svn reported a conflict in, or a resumed one', async () => {
    const h = await harness()
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands).toHaveLength(3)
    expect(h.deps.svn.conflictSet).not.toHaveBeenCalled()
    h.conflict(true)
    expect(await h.update.run('worker', 'finish-2', h.root, 3)).toMatchObject({ complete: false })
    expect(h.deps.svn.conflictSet).toHaveBeenCalledTimes(1)
    h.conflict(false)
    expect(await h.update.run('worker', 'finish-2', h.root, 3)).toMatchObject({ complete: true })
    expect(h.deps.svn.conflictSet).toHaveBeenCalledTimes(2)
  })

  it('compares the definitions of a parent once for all its externals', async () => {
    const h = await harness()
    await h.update.run('worker', 'finish', h.root, 2)
    const parentReads = vi.mocked(h.deps.targets.snapshot).mock.calls.filter(([item, discover, protect]) => item.path === h.root && discover === false && protect === undefined)
    expect(parentReads).toHaveLength(1)
  })

  it.each([
    ["Updating '.':\nAt revision 7.\n", true],
    ["Updating '.':\nU    src/a.ts\nA    src/b.ts\nUpdated to revision 8.\n", true],
    ["Updating '.':\nC    f.txt\n C   g.txt\nUpdated to revision 2.\nSummary of conflicts:\n  Text conflicts: 1\n  Property conflicts: 1\n", false],
    ["Updating '.':\n   C dir\nUpdated to revision 3.\n", false],
    ["Updating '.':\nSkipped 'f.txt' -- Node remains in conflict\nAt revision 3.\nSummary of conflicts:\n  Skipped paths: 1\n", false],
  ])('tells a conflict-free update output apart: %j', (output, clean) => {
    expect(WorktreeUpdate.conflictFree(output)).toBe(clean)
  })

  it('runs no svn command in 30 mounts one read proves at their target and journals one summary', async () => {
    const h = await harness()
    const mounts = Array.from({ length: 30 }, (_, index) => h.target(`shared/m${String(index).padStart(2, '0')}`, index < 9 ? 248 : 301))
    h.snapshots.get(h.root)!.children = mounts
    for (const mount of mounts) h.at(mount)
    expect(await h.update.run('worker', 'finish', h.root, 963)).toMatchObject({ complete: true, revision: 963, runId: 'note-1' })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root])
    expect(h.deps.svn.mountStates).toHaveBeenCalledTimes(1)
    expect(h.deps.targets.verify).not.toHaveBeenCalledWith(expect.objectContaining({ path: mounts[0].path }), expect.anything())
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0].title).toBe('30 externals already at r248, r301')
    expect(h.notes[0].text).toContain('shared/m00 r248\n')
    const state = h.records.get('worker')!.worktreeLifecycle!.update!
    expect(state).toMatchObject({ completed: true, cursor: 31 })
    expect(state.units.every((unit) => unit.phase === 'done')).toBe(true)
  })

  it('updates only the mount behind its target and proves the rest from the same read', async () => {
    const h = await harness()
    h.at(h.library, { base: 7 })
    h.at(h.next)
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path])
    expect(h.deps.targets.verify).toHaveBeenCalledWith(expect.objectContaining({ path: h.library.path }), true, [])
    expect(h.notes.map((note) => note.title)).toEqual(['1 external already at r12'])
  })

  it.each<[string, Partial<SvnMountState> | 'absent' | 'mapping']>([
    ['a mixed BASE', { base: 'mixed' }],
    ['a switched node', { switched: true }],
    ['a missing node', { missing: true }],
    ['a skipped or conflicted node', { skipped: true }],
    ['another URL', { url: 'https://svn.test/elsewhere' }],
    ['its own external definitions', { carrier: true }],
    ['no entry in the read (not on disk)', 'absent'],
    ['a changed mapping saved before the update', 'mapping'],
  ])('takes the update path for a mount at its revision with %s', async (_name, patch) => {
    const h = await harness()
    h.at(h.next)
    if (patch === 'mapping') {
      h.reject(h.library.path)
      await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, update: { ...record.worktreeLifecycle!.update!,
        units: record.worktreeLifecycle!.update!.units.map((unit, index) => index === 1 ? { ...unit, mappingChanged: true } : unit) } } }))
      h.reject()
      h.at(h.library)
    }
    else if (patch !== 'absent') h.at(h.library, patch)
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands.filter((row) => row.cwd === h.library.path).length).toBeGreaterThan(0)
    expect(h.commands.some((row) => row.cwd === h.next.path)).toBe(false)
  })

  it('never replaces a phase saved after an update with a proof of the read', async () => {
    const h = await harness()
    h.deps.targets.verify = vi.fn(async (target: SvnUpdateTarget, revision = true) => {
      if (revision && target.path === h.library.path) throw new Error('verification interrupted')
    })
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('verification interrupted')
    expect(h.records.get('worker')!.worktreeLifecycle!.update!.units[1]).toMatchObject({ phase: 'updated' })
    h.deps.targets.verify = vi.fn(async () => {})
    h.at(h.library); h.at(h.next)
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: true })
    expect(h.deps.svn.conflictSet).toHaveBeenCalled()
    expect(h.deps.targets.verify).toHaveBeenCalledWith(expect.objectContaining({ path: h.library.path }), true, [])
    expect(h.notes.map((note) => note.title)).toEqual(['1 external already at r12'])
  })

  it('reads the mounts again after a native reconcile touched them', async () => {
    const h = await harness()
    h.snapshots.set(h.library.path, { properties: {}, localMappingChanges: false, children: [], missing: [join(h.library.path, 'nested')], mismatched: [] })
    const run = h.deps.runner.run
    h.deps.runner.run = async (...args) => {
      const result = await run(...args)
      if (!args[3].includes('--ignore-externals')) h.snapshots.get(h.library.path)!.missing = []
      return result
    }
    h.at(h.library, { base: 7 }); h.at(h.next)
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path, h.library.path])
    expect(h.deps.svn.mountStates).toHaveBeenCalledTimes(2)
  })

  it('requires verification before advancing the saved cursor', async () => {
    const h = await harness()
    h.deps.targets.verify = async (_target, revision = true) => { if (revision) throw new Error('Skipped obstructed target') }
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('Skipped obstructed target')
    expect(h.records.get('worker')?.worktreeLifecycle?.update).toMatchObject({ cursor: 0, completed: false, units: [{ phase: 'updated' }] })
  })

  it('updates a clean mount behind its target before it hands over the conflicts of the root, and never touches the root again', async () => {
    const h = await harness()
    h.at(h.library, { base: 7 }); h.at(h.next)
    h.conflictAt({ path: 'app.ts', kind: 'text', in: h.root })
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: false, runId: 'run-1' })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path])
    expect(h.commands[1].args).toEqual(['update', '-r', '8', '--ignore-externals', '--accept', 'postpone', '--', '.'])
    const paused = h.records.get('worker')!.worktreeLifecycle!.update!
    expect(paused).toMatchObject({ cursor: 0, units: [{ phase: 'updated' }, { phase: 'updated', parent: 0 }, { phase: 'pending', parent: 0 }] })
    h.conflict(false)
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: true })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path])
    expect(h.deps.targets.verify).toHaveBeenCalledWith(expect.objectContaining({ path: h.library.path, revision: 8 }), true, [])
  })

  it('leaves a mount with local changes behind its target until the conflicts are settled', async () => {
    const h = await harness()
    h.at(h.library, { base: 7, localChanges: true }); h.at(h.next)
    h.conflictAt({ path: 'app.ts', kind: 'text', in: h.root })
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: false })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root])
    h.conflict(false)
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path])
  })

  it('still hands over the conflicts of the root when the early discovery of its externals fails', async () => {
    const h = await harness()
    const snapshot = h.deps.targets.snapshot
    h.deps.targets.snapshot = vi.fn(async (item: SvnUpdateTarget, discover = true, ...rest: [boolean?]) => {
      if (discover && item.path === h.root) throw new Error('svn info -r HEAD failed')
      return snapshot(item, discover, ...rest)
    })
    h.conflictAt({ path: 'app.ts', kind: 'text', in: h.root })
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: false, runId: 'run-1' })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root])
    expect(h.records.get('worker')!.worktreeLifecycle!.update).toMatchObject({ cursor: 0, units: [{ phase: 'updated' }] })
  })

  it('journals the mounts it proved at their target when a later mount fails', async () => {
    const h = await harness()
    h.at(h.library)
    h.reject(h.next.path)
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('network interrupted')
    expect(h.notes.map((note) => note.title)).toEqual(['1 external already at r8'])
  })

  it.each(['tree', 'property'] as const)('finds no external of a root whose %s conflict may hide its definitions', async (kind) => {
    const h = await harness()
    h.at(h.library, { base: 7 })
    h.conflictAt({ path: kind === 'tree' ? 'gone' : '.', kind, in: h.root, properties: kind === 'property' ? ['svn:externals'] : [] })
    await h.update.run('worker', 'finish', h.root, 2)
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root])
    expect(h.records.get('worker')!.worktreeLifecycle!.update!.units).toHaveLength(1)
  })

  it('keeps the numeric target of an external found before the conflicts settled, while its repository moves on', async () => {
    const h = await harness()
    h.at(h.library, { localChanges: true, base: 7 })
    h.conflictAt({ path: 'app.ts', kind: 'text', in: h.root })
    await h.update.run('worker', 'finish', h.root, 2)
    h.snapshots.get(h.root)!.children = [{ ...h.library, revision: 9 }, h.next]
    h.conflict(false)
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: true })
    expect(h.commands.at(1)).toMatchObject({ cwd: h.library.path, args: expect.arrayContaining(['8']) })
  })

  it('refuses a resume whose root changed the definitions of an external it found before the conflicts settled', async () => {
    const h = await harness()
    h.conflictAt({ path: 'app.ts', kind: 'text', in: h.root })
    await h.update.run('worker', 'finish', h.root, 2)
    h.conflict(false); h.changed()
    await expect(h.update.run('worker', 'finish', h.root, 2)).rejects.toThrow('External definitions changed')
    expect(h.records.get('worker')!.worktreeLifecycle!.update!.cursor).toBe(0)
  })

  it('stops updating clean mounts at a failure and still hands the conflicts over', async () => {
    const h = await harness()
    h.at(h.library, { base: 7 }); h.at(h.next, { base: 11 })
    h.conflictAt({ path: 'app.ts', kind: 'text', in: h.root })
    const run = h.deps.runner.run
    h.deps.runner.run = async (...args) => args[2] === h.library.path
      ? (h.commands.push({ cwd: args[2], args: args[3] }), { ok: false, failure: 'network', output: 'svn: E170013', exitCode: 1, runId: 'failed' })
      : run(...args)
    expect(await h.update.run('worker', 'finish', h.root, 2)).toMatchObject({ complete: false })
    expect(h.commands.map((row) => row.cwd)).toEqual([h.root, h.library.path])
    expect(h.records.get('worker')!.worktreeLifecycle!.update!.units.map((unit) => unit.phase)).toEqual(['updated', 'pending', 'pending'])
  })

  it('recovers a lost reply of a clean mount the conflict pause updated', async () => {
    const h = await harness()
    h.at(h.library, { base: 7 })
    h.conflictAt({ path: 'app.ts', kind: 'text', in: h.root })
    await h.update.run('worker', 'finish', h.root, 2)
    const state = h.records.get('worker')!.worktreeLifecycle!.update!
    const entry = { stepId: `finish-update-${state.generation}-1`, kind: 'update' as const, attempt: 1, targetRevision: 8, cwd: h.library.path, startedAt: 1, runId: 'lost' }
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [entry] } }))
    expect(await h.update.recover('worker', entry, false)).toBe(true)
    expect(h.commands.at(-1)).toMatchObject({ cwd: h.library.path, args: ['cleanup', '--', '.'] })
  })
})
