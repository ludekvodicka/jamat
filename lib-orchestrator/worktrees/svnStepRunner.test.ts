import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { SessionRecordsStore } from '../sessionManager/worktreeSessionRecords'
import { ScriptLogStore } from '../sessionManager/worktreeSessionScripts'
import { SessionScriptsManager } from '../sessionManager/worktreeSessionScripts'
import { WorktreeLease } from './worktreeLease'
import { WorktreeSvnCommands } from './worktreeSvnCommands'
import { SvnStepRunner } from './svnStepRunner'

const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'jamat-svn-step-'))
  directories.push(directory)
  const file = join(directory, 'records.json')
  const store = await SessionRecordsStore.load(file, { snapshotsDirectory: join(directory, 'snapshots'), report: () => {} })
  await store.put({ sessionId: 'parent', kind: 'shell', title: 'Tree', directory: { mode: 'default' }, binding: null, life: 'live', createdAt: 1,
    worktree: { kind: 'svn', worktreePath: directory, repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' } })
  const logs = new ScriptLogStore(join(directory, 'logs'))
  const unreachable = async (): Promise<never> => { throw new Error('Host must not be used') }
  const scripts = new SessionScriptsManager({ records: store, logs,
    host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable }, now: () => 1000,
    report: () => {}, onCollapsed: () => {} })
  const svn: CommandRunner = { run: vi.fn(async (_cwd, _args, options) => {
    options?.onStdout?.('Updated to revision 2.\n')
    return { code: 0, stdout: 'Updated to revision 2.\n', stderr: '', failure: null }
  }) }
  const runner = new SvnStepRunner({ records: store, scripts, svn, now: () => 2000, newId: () => 'run', changed: () => {} })
  return { store, logs, runner, svn, file, directory, scripts }
}

describe('SvnStepRunner', () => {
  it.each(['', 'shared/library'])('marks main-copy UPDATE at its owning root for cwd %j while its worktree remains present', async (target) => {
    const h = await harness(), tree = join(h.directory, '.worktrees', 'retained'), lease = new WorktreeLease('main-update', () => [])
    await h.store.update('parent', (record) => ({ ...record, worktree: { ...record.worktree!, worktreePath: tree },
      svnAction: { actionId: 'update', kind: 'update-main', stage: 'updating', root: h.directory, checks: [], checkCursor: 0, rootCursor: 0,
        rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1 } }))
    h.svn.run = async (cwd) => {
      expect(cwd).toBe(join(h.directory, target))
      expect(await readFile(`${WorktreeLease.fileOf(h.directory)}.writer`, 'utf8')).toContain('main-update')
      await expect(readFile(`${WorktreeLease.fileOf(tree)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
      return { code: 0, stdout: '', stderr: '', failure: null, closed: true }
    }
    const commands = new WorktreeSvnCommands(h.svn, lease, async () => 'stop')
    const runner = new SvnStepRunner({ records: h.store, scripts: h.scripts, svn: commands, lease, now: () => 2, newId: () => 'main', changed: () => {} })
    expect(await runner.run('parent', 'update', join(h.directory, target), ['update'], { stepId: 'update', attempt: 1 })).toMatchObject({ ok: true })
    await expect(readFile(`${WorktreeLease.fileOf(h.directory)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('durably records intent before execution, then saved log, history and done', async () => {
    const h = await harness()
    const execute = h.svn.run
    h.svn.run = async (...args) => {
      const loaded = await SessionRecordsStore.load(h.file, { snapshotsDirectory: join(h.directory, 'snapshots'), report: () => {} })
      expect(loaded.get('parent')?.worktreeLifecycle?.journal[0]).toMatchObject({ kind: 'update', runId: 'run', startedAt: 1000 })
      expect(loaded.get('parent')?.worktreeLifecycle?.journal[0].endedAt).toBeUndefined()
      expect(loaded.get('parent')?.scriptRuns?.[0]).toMatchObject({ outcome: 'lost', scriptId: 'svn' })
      return execute(...args)
    }
    expect(await h.runner.run('parent', 'update', h.directory, ['update', '-r', '2'], { stepId: 'update', attempt: 1, targetRevision: 2 }))
      .toMatchObject({ ok: true, exitCode: 0 })
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[0]).toMatchObject({ endedAt: 2000, outcome: 'ok', targetRevision: 2 })
    expect(h.store.get('parent')?.scriptRuns?.[0]).toMatchObject({ outcome: 'succeeded', exitCode: 0, log: { state: 'saved' } })
    expect((await h.logs.read('parent', 'run', 1000))?.text).toContain('Updated to revision 2')
  })

  it('leaves the journal and lost row open after final log failure', async () => {
    const h = await harness()
    h.svn.run = async () => {
      vi.spyOn(h.logs, 'write').mockResolvedValue({ ok: false, detail: 'disk full' })
      return { code: 0, stdout: '', stderr: '', failure: null }
    }
    await expect(h.runner.run('parent', 'update', h.directory, ['update'], { stepId: 'update', attempt: 1 })).rejects.toThrow('disk full')
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[0].endedAt).toBeUndefined()
    expect(h.store.get('parent')?.scriptRuns?.[0].outcome).toBe('lost')
  })

  it('does not execute when recording the intent fails', async () => {
    const h = await harness()
    vi.spyOn(h.store, 'update').mockResolvedValue(false)
    await expect(h.runner.run('parent', 'update', h.directory, ['update'], { stepId: 'update', attempt: 1 })).rejects.toThrow('record its start')
    expect(h.svn.run).not.toHaveBeenCalled()
  })

  it('keeps an open intent if the done write fails after the log was saved', async () => {
    const h = await harness()
    const update = h.store.update.bind(h.store)
    let writes = 0
    vi.spyOn(h.store, 'update').mockImplementation((...args) => ++writes === 3 ? Promise.resolve(false) : update(...args))
    await expect(h.runner.run('parent', 'update', h.directory, ['update'], { stepId: 'update', attempt: 1 })).rejects.toThrow('recovery is required')
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[0].endedAt).toBeUndefined()
    expect((await h.logs.read('parent', 'run', 1000))?.text).toContain('Updated to revision 2')
  })

  it('classifies captured authentication errors and persists the failure', async () => {
    const h = await harness()
    h.svn.run = async (_cwd, _args, options) => {
      options?.onStderr?.('svn: E170001: Authentication failed')
      return { code: 1, stdout: '', stderr: 'svn: E170001: Authentication failed', failure: null }
    }
    expect(await h.runner.run('parent', 'update', h.directory, ['update'], { stepId: 'update', attempt: 1 }))
      .toMatchObject({ ok: false, failure: 'auth', exitCode: 1 })
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[0]).toMatchObject({ outcome: 'auth', endedAt: 2000 })
  })
  it.each(['timeout', 'aborted'] as const)('keeps the %s reason after partial progress', async (failure) => {
    const h = await harness()
    h.svn.run = async (_cwd, _args, options) => {
      options?.onStdout?.('Updating file...')
      return { code: -1, stdout: 'Updating file...', stderr: '', failure }
    }
    expect(await h.runner.run('parent', 'update', h.directory, ['update'], { stepId: 'update', attempt: 1 }))
      .toMatchObject({ ok: false, output: expect.stringContaining(`stopped: ${failure}`) })
    expect((await h.logs.read('parent', 'run', 1000))?.text).toContain(`stopped: ${failure}`)
  })

  it('saves preparation failures without launching SVN or closing the intent', async () => {
    const h = await harness()
    await expect(h.runner.run('parent', 'commit', h.directory, ['commit'], { stepId: 'commit', attempt: 1 },
      { beforeRun: async () => { throw new Error('prepared adds could not be saved') } })).rejects.toThrow('prepared adds')
    expect(h.svn.run).not.toHaveBeenCalled()
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[0].endedAt).toBeUndefined()
    expect((await h.logs.read('parent', 'run', 1000))?.text).toContain('prepared adds could not be saved')
  })

  it('stops after two identical failures across reload and refuses a third invocation with its saved log', async () => {
    const h = await harness()
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'svn: E170001: Authentication failed', failure: null }))
    h.svn.run = run
    const intent = { stepId: 'sync', attempt: 1, targetRevision: 2 }
    await h.runner.run('parent', 'update', h.directory, ['update'], intent, { runId: 'first' })
    const second = await h.runner.run('parent', 'update', h.directory, ['update'], intent, { runId: 'second' })
    expect(second.output).toMatch(/Stopped after two identical failures: svn sign-in needed. Log: .*second/)
    expect(second.output).toContain('E170001')
    const loaded = await SessionRecordsStore.load(h.file, { snapshotsDirectory: join(h.directory, 'snapshots'), report: () => {} })
    expect(loaded.get('parent')?.worktreeLifecycle?.stoppedFailure).toBe(second.output)
    expect((await h.runner.run('parent', 'update', h.directory, ['update'], intent, { runId: 'third' })).output).toBe(second.output)
    expect(run).toHaveBeenCalledTimes(2)
    expect(h.store.get('parent')?.worktreeLifecycle?.journal).toHaveLength(2)
  })
  it.each([['E170001', 'E170013'], ['E155011', 'E155011']])('allows different classes and the out-of-date exception (%s, %s)', async (first, second) => {
    const h = await harness()
    const run = vi.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: first, failure: null })
      .mockResolvedValue({ code: 1, stdout: '', stderr: second, failure: null })
    h.svn.run = run
    for (let n = 1; n <= 3; n++) await h.runner.run('parent', 'update', h.directory, ['update'], { stepId: 'sync', attempt: n }, { runId: String(n) })
    expect(run).toHaveBeenCalledTimes(3)
  })

  /** UA1-J09-6: each recovery cleanup the guard refused stayed an open intent, and each Try again ran its cleanup once more. */
  it('closes the intent of a command refused before svn started, and keeps one open once svn ran', async () => {
    const h = await harness()
    h.svn.run = async () => { throw new Error('The svn state changed outside Jamat') }
    await expect(h.runner.run('parent', 'cleanup', h.directory, ['cleanup'], { stepId: 'recovery-cleanup', attempt: 1 })).rejects.toThrow('changed outside')
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[0]).toMatchObject({ endedAt: 2000, outcome: 'other', output: expect.stringContaining('changed outside') })
    h.svn.run = async (_cwd, _args, options) => { options?.onSpawn?.(42); throw new Error('The fingerprint could not be saved') }
    await expect(h.runner.run('parent', 'cleanup', h.directory, ['cleanup'], { stepId: 'recovery-cleanup', attempt: 2 }, { runId: 'spawned' })).rejects.toThrow('fingerprint')
    expect(h.store.get('parent')?.worktreeLifecycle?.journal[1].endedAt).toBeUndefined()
  })
})
