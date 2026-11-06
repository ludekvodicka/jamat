import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CommandRunner } from '../../shared/commandInvoker.types'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import { WorktreeResultsStore } from '../results/worktreeResultsStore'
import { ResultRemovals } from './resultRemovals'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function harness(options: { status?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jamat-result-removals-'))
  roots.push(root)
  const mainCopy = join(root, 'main')
  const worktreePath = join(mainCopy, '.worktrees', '098-x')
  // Run 098: everything but the directory an orphaned probe held as its working directory was gone.
  await mkdir(join(worktreePath, 'lib-orchestrator'), { recursive: true })
  const directoryId = await SvnWorktreeManager.directoryIdOf(worktreePath)
  const svnCalls: string[][] = []
  const runner: CommandRunner = { run: async (_cwd, args) => {
    svnCalls.push(args)
    if (args[0] === 'status' && options.status !== undefined) return { code: 0, stdout: options.status, stderr: '', failure: null }
    throw new Error(`unexpected svn ${args.join(' ')}`)
  } }
  const svn = new SvnWorktreeManager(runner)
  const failures: string[] = []
  const results = new WorktreeResultsStore(join(root, 'results'), { logs: new ScriptLogStore(join(root, 'logs')), now: () => Date.now(), report: (line) => failures.push(line) })
  await results.load()
  await results.put(WorktreeResultsStore.recordOf({ actionId: 'finish-098', action: 'discard', result: 'committed', sessionId: 'gone', title: '098',
    worktreePath, mainCopy, directoryId, removal: 'pending', revisions: [{ repository: 'url', revision: 980, label: 'receipt' }],
    lines: ['REMOVAL BLOCKED (EPERM)'], logs: [], at: Date.now(), caller: undefined }))
  let records: SessionRecord[] = []
  const store = { listAll: () => records, latched: false, loadedFromFile: true, archiveRead: true }
  const removals = new ResultRemovals({ results, records: store, svn, report: (line) => failures.push(line), now: () => Date.now() })
  return { root, mainCopy, worktreePath, directoryId, results, removals, failures, svnCalls, store, setRecords: (next: SessionRecord[]) => { records = next } }
}

const removal = (h: Awaited<ReturnType<typeof harness>>) => h.results.list({})[0].removal

describe('ResultRemovals (I67, run 098)', () => {
  it('removes the folder of a committed, discarded result whose session is gone, by its directory identity and without svn', async () => {
    const h = await harness()
    if (h.directoryId === null) return
    await h.removals.run()
    expect(existsSync(h.worktreePath)).toBe(false)
    expect(existsSync(join(h.mainCopy, '.worktrees'))).toBe(false)
    expect(removal(h)).toBe('removed')
    expect(h.results.list({})[0].lines).toContain('   worktree removed after the session')
    expect(h.svnCalls).toEqual([])
    expect(h.failures).toEqual([])
  })

  it('never removes another directory at the recorded path, and leaves the result pending', async () => {
    const h = await harness()
    if (h.directoryId === null) return
    await rm(h.worktreePath, { recursive: true })
    await mkdir(h.worktreePath)
    await h.removals.run()
    expect(existsSync(h.worktreePath)).toBe(true)
    expect(removal(h)).toBe('pending')
  })

  it('keeps a folder that holds work no svn status can prove clean, and removes one a clean status accepts', async () => {
    const kept = await harness()
    if (kept.directoryId === null) return
    await writeFile(join(kept.worktreePath, 'lib-orchestrator', 'note.txt'), 'work\n')
    await kept.removals.run()
    expect(existsSync(join(kept.worktreePath, 'lib-orchestrator', 'note.txt'))).toBe(true)
    expect(removal(kept)).toBe('pending')

    const clean = await harness({ status: '<?xml version="1.0"?><status><target path="."><entry path="."><wc-status item="normal" props="none"/></entry></target></status>' })
    await mkdir(join(clean.worktreePath, '.svn'))
    await writeFile(join(clean.worktreePath, 'a.txt'), 'published\n')
    await clean.removals.run()
    expect(clean.svnCalls.map((args) => args[0])).toEqual(['status'])
    expect(existsSync(clean.worktreePath)).toBe(false)
    expect(removal(clean)).toBe('removed')
  })

  it('leaves a folder a session record still names, or a live session works in, to that session', async () => {
    const h = await harness()
    if (h.directoryId === null) return
    const owner: SessionRecord = { sessionId: 'worker', kind: 'agent', title: 'Worker', binding: null, life: 'ended', createdAt: 0, directory: { mode: 'default' },
      worktree: { kind: 'svn', repositoryRoot: h.mainCopy, worktreePath: h.worktreePath, branch: 'url', baseCommit: 'r1' } }
    h.setRecords([owner])
    await h.removals.run()
    expect(existsSync(h.worktreePath)).toBe(true)
    h.setRecords([{ ...owner, worktree: undefined, sessionId: 'solve', life: 'live', directory: { mode: 'adHoc', path: join(h.worktreePath, 'lib-orchestrator') } }])
    await h.removals.run()
    expect(existsSync(h.worktreePath)).toBe(true)
    expect(removal(h)).toBe('pending')
  })

  it.each([['the records file was not read', { loadedFromFile: false }], ['the archive was not read', { archiveRead: false }],
    ['the records store is latched', { latched: true }]] as const)('removes nothing while %s, because no record can say it owns the folder', async (_why, flags) => {
    const h = await harness()
    Object.assign(h.store, flags)
    await h.removals.run()
    expect(existsSync(h.worktreePath)).toBe(true)
    expect(removal(h)).toBe('pending')
  })

  it('finishes the result of a folder that is gone, but not while its main copy is missing too', async () => {
    const h = await harness()
    await rm(h.worktreePath, { recursive: true })
    await h.removals.run()
    expect(removal(h)).toBe('removed')
    const away = await harness()
    await rm(away.mainCopy, { recursive: true })
    await away.removals.run()
    expect(removal(away)).toBe('pending')
  })

  it('runs its first pass at once and then at most every ten minutes', async () => {
    const h = await harness()
    let clock = 1_000_000
    const removals = new ResultRemovals({ results: { list: (filter) => { calls += 1; return h.results.list(filter) }, removalDone: (id) => h.results.removalDone(id) },
      records: { listAll: () => [], latched: false, loadedFromFile: true, archiveRead: true }, svn: new SvnWorktreeManager({ run: async () => { throw new Error('no svn') } }), report: () => {}, now: () => clock })
    let calls = 0
    await removals.due()
    await removals.due()
    clock += 10 * 60_000 - 1
    await removals.due()
    expect(calls).toBe(1)
    clock += 1
    await removals.due()
    expect(calls).toBe(2)
  })
})
