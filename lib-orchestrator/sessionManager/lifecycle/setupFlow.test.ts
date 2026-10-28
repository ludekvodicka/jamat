import { testAssembly } from '../../worktrees/worktreeTesting'
import { SetupInputs } from '../../projectSetup/setupInputs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionRecord } from '../records/sessionRecord.types'
import { ScriptChain } from '../scripts/scriptChain'
import { ScriptLogStore } from '../scripts/scriptLogStore'
import { SessionScriptsManager } from '../scripts/sessionScriptsManager'
import { SvnStepRunner } from '../../worktrees/svnStepRunner'
import { SvnCheckoutStep } from '../../worktrees/worktreeProvision'
import { WorktreeLifecycleMigration } from '../../worktrees/worktreeLifecycleMigration'

import { ProjectSetupManager } from '../../projectSetup/projectSetupManager'
import { SetupFamilies } from '../../projectSetup/setupFamilies'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { CommandAgreement } from '../scripts/commandAgreement'
import { CommandTrustStore } from '../scripts/commandTrustStore'
import type { SetupFlowDeps } from './setupFlow'
import { SetupFlow } from './setupFlow'
import { SetupWorkflow } from './setupWorkflow'

describe('lib-orchestrator/sessionManager/lifecycle/setupFlow', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function unexpected(name: string): never {
    throw new Error(`${name} is not part of planning the before chain`)
  }

  /** Keys are paths relative to the returned root; a file whose content does not matter is empty. */
  function directory(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-setup-flow-'))
    created.push(root)
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
    return root
  }

  async function flowOf(root: string, overrides: Partial<SetupFlowDeps> = {}): Promise<SetupFlow> {
    const records = await SessionRecordsStore.load(join(root, 'session-records.json'), {
      snapshotsDirectory: join(root, 'snapshots'),
      report: () => undefined,
    })
    return new SetupFlow({
      records,
      svn: { assembly: () => unexpected('assembly'), changes: () => unexpected('changes'), commitHashes: () => unexpected('commitHashes') },
      localBefore: { accepts: () => false, run: () => unexpected('local before') }, detach: () => unexpected('detach'),
      setup: new ProjectSetupManager({ platformSettingsOf: () => SetupFamilies.defaultPlatformSettings() }),
      agreement: new CommandAgreement({ trust: CommandTrustStore.load(join(root, 'setup-trust.json'), () => undefined) }),
      scripts: { succeededKeys: () => unexpected('succeededKeys') },
      runs: { launch: () => unexpected('launch') },
      launch: {
        replayLaunch: () => unexpected('replayLaunch'),
        unrecordedWorktree: () => unexpected('unrecordedWorktree'),
        startRefusal: () => unexpected('startRefusal'),
      },
      worktrees: { purgeReserved: () => unexpected('purgeReserved') },
      report: () => undefined,
      newId: () => unexpected('newId'),
      now: () => 5_000,
      ...overrides,
    })
  }

  /*
   * An SVN worktree of a product group checks out the whole group, and `setupProjectOf` names the
   * group root. Its members are what installs, with no agreement asked: the steps are this machine's.
   */
  it.each([false, true])('captures setup hashes before launch, retaining the wait when the read fails: %s', async (failure) => {
    const root = directory({})
    const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots'), report: () => undefined })
    await records.put({ sessionId: 'parent', kind: 'shell', title: 'parent', directory: { mode: 'default' }, binding: null, life: 'starting', createdAt: 1,
      pendingOperationId: 'launch', pendingOperationKind: 'create', pendingSetup: { setupSessionId: 'setup' },
      worktree: { kind: 'svn', worktreePath: root, repositoryRoot: 'Q:/main', branch: 'https://svn.test/app', baseCommit: 'r1' } })
    const replayLaunch = vi.fn(async () => {
      expect(records.get('parent')?.pendingSetup).toBeUndefined()
      expect(records.get('parent')?.worktree?.setupBaseline).toEqual({ at: 5000, inputs: SetupInputs.of(testAssembly().nodes).digest, inputHashes: SetupInputs.of(testAssembly().nodes).hashes, hashes: { 'pkg/package-lock.json': 'properties-and-content', 'removed.txt': 'missing-and-properties' } })
      return null
    })
    const commitHashes = vi.fn(async () => failure ? { ok: false as const, code: 'svn-failed' as const, detail: 'unreadable properties' }
      : { ok: true as const, value: { 'pkg/package-lock.json': 'properties-and-content', 'removed.txt': 'missing-and-properties' } })
    const flow = await flowOf(root, { records, svn: {
      assembly: async () => ({ ok: true, value: testAssembly() }),
      changes: async () => ({ ok: true, value: ['pkg/package-lock.json', 'removed.txt'].map((path) => ({ path, kind: 'item', conflict: false })) }), commitHashes },
      launch: { replayLaunch, unrecordedWorktree: () => unexpected('unrecordedWorktree'), startRefusal: async () => null } })
    await flow.applyBeforeSucceeded('parent')
    expect(commitHashes).toHaveBeenCalledWith(root, ['pkg/package-lock.json', 'removed.txt'])
    expect(replayLaunch).toHaveBeenCalledTimes(failure ? 0 : 1)
    if (failure) expect(records.get('parent')).toMatchObject({ life: 'ended', pendingSetup: { setupSessionId: 'setup' }, endedReason: expect.stringContaining('unreadable properties') })
  })

  it.each(['fresh', 'partial', 'identity', 'locked', 'conflicts'] as const)('runs the local checkout before setup: %s', async (mode) => {
    const root = directory({ 'Svc/package.json': '{}', 'Svc/pnpm-lock.yaml': '' })
    const main = directory({ '.appgroup': '{"kind":"product"}', 'Svc/package.json': '{}', 'Unpublished/package.json': '{}' })
    const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots'), report: () => {} })
    const logs = new ScriptLogStore(join(root, 'logs'))
    const unreachable = async (): Promise<never> => { throw new Error('Host must not run checkout') }
    const scripts = new SessionScriptsManager({ records, logs, now: () => 5000, report: () => {}, onCollapsed: () => {},
      host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable } })
    const calls: string[][] = []
    let id = 0
    const runner = new SvnStepRunner({ records, scripts, now: () => 5000, newId: () => `local-${++id}`, changed: () => {},
      svn: { run: async (_cwd, args, options) => {
        calls.push(args)
        const failed = mode === 'locked' && args[0] === 'cleanup'
        options?.onStdout?.(failed ? 'svn: E155004: Working copy locked' : 'Checked out revision 42.')
        return { code: failed ? 1 : 0, stdout: failed ? 'svn: E155004: Working copy locked' : 'Checked out revision 42.', stderr: '', failure: null }
      } } })
    const step = ScriptChain.processStepOf('svn', 'checkout', { tool: 'svn', cwd: root, args: ['checkout', '-r', '42', 'url', '.'] })
    const steps = [step, { key: 'setup', scriptId: 'setup' as const, name: 'setup', commands: [{ command: 'install', cwd: root }] }]
    const worktree = { kind: 'svn' as const, worktreePath: root, repositoryRoot: main, branch: 'url', baseCommit: 'r42', directoryId: 'reserved', setupScope: 'members' as const }
    const parent: SessionRecord = { sessionId: 'parent', kind: 'shell', title: 'Tree', directory: { mode: 'default' }, binding: null,
      life: 'starting', createdAt: 1, pendingOperationId: 'launch', pendingOperationKind: 'create', worktree }
    const launched: string[] = []
    const detached: Promise<unknown>[] = []
    const flow = await flowOf(root, { records, scripts, newId: () => `id-${++id}`, detach: (work) => { detached.push(work) },
      localBefore: new SvnCheckoutStep({ records, runner, now: () => 5000, svn: { status: async () => ({ ok: true, value: { textConflicts: mode === 'conflicts' ? ['a.txt'] : [], otherConflicts: [], changed: [] } }),
        revisionOf: async () => ({ ok: true, value: 42 }), reservedCheck: async (wanted) => {
        expect(wanted).toEqual({ worktreePath: root, directoryId: 'reserved', url: 'url' })
        return mode === 'identity' ? { ok: false, code: 'refused', detail: 'Reservation identity changed' }
          : { ok: true, value: { workingCopy: mode !== 'fresh' } }
      } } }), runs: { launch: async (record) => {
        expect(record.commands).toEqual([{ command: 'pnpm install', cwd: join(root, 'Svc') }])
        launched.push(record.scriptOf!.scriptId); return { ok: true, value: undefined }
      } } })
    if (mode === 'fresh') {
      expect(await flow.createWithSetup(parent, worktree, steps)).toMatchObject({ ok: true })
      await Promise.all(detached)
    } else {
      await records.put({ ...parent, pendingSetup: { local: true, setupSessionId: 'old', steps, cursor: 0 },
        worktreeLifecycle: { ...WorktreeLifecycleMigration.fromOld(parent)!, journal: [{ kind: 'checkout', stepId: 'checkout', runId: 'old', attempt: 1, startedAt: 1, targetRevision: 42 }] } })
      await flow.recoverLocalBefore('parent')
    }
    if (mode === 'identity' || mode === 'locked' || mode === 'conflicts') {
      expect(launched).toEqual([])
      expect(records.get('parent')).toMatchObject({ life: 'ended', pendingSetup: { local: true } })
      expect(records.get('parent')?.worktreeLifecycle?.journal[0].endedAt).toBeUndefined()
      expect(calls).toHaveLength(mode === 'identity' ? 0 : mode === 'locked' ? 1 : 2)
    } else {
      expect(launched).toEqual(['setup'])
      expect(calls).toEqual(mode === 'fresh' ? [['checkout', '-r', '42', 'url', '.']]
        : [['cleanup', '--', '.'], ['update', '-r', '42', '--accept', 'postpone', '--', '.']])
      expect(records.get('parent')?.pendingSetup?.local).toBeUndefined()
      expect(records.get('parent')?.worktreeLifecycle?.journal.every((entry) => entry.endedAt !== undefined)).toBe(true)
      const row = records.get('parent')?.scriptRuns?.at(-1)
      expect(row).toMatchObject({ outcome: 'succeeded', phase: 'before' })
      expect((await logs.read('parent', row!.runId, 1000))?.text).toContain('revision 42')
    }
  })

  // Agree and run re-arms the wait with a fresh id and recovers a worktree that may already exist.
  it('runs the first checkout of an agreed setup under the step the wait names, so it is no earlier attempt', async () => {
    const root = directory({})
    const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots'), report: () => {} })
    const logs = new ScriptLogStore(join(root, 'logs'))
    const unreachable = async (): Promise<never> => { throw new Error('Host must not run checkout') }
    const scripts = new SessionScriptsManager({ records, logs, now: () => 5000, report: () => {}, onCollapsed: () => {},
      host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable } })
    let id = 0
    const runner = new SvnStepRunner({ records, scripts, now: () => 5000, newId: () => `local-${++id}`, changed: () => {},
      svn: { run: async () => ({ code: 0, stdout: 'Checked out revision 42.', stderr: '', failure: null }) } })
    const step = ScriptChain.processStepOf('svn', 'checkout', { tool: 'svn', cwd: root, args: ['checkout', '-r', '42', 'url', '.'] })
    const worktree = { kind: 'svn' as const, worktreePath: root, repositoryRoot: root, branch: 'url', baseCommit: 'r42', directoryId: 'reserved' }
    const parent: SessionRecord = { sessionId: 'parent', kind: 'shell', title: 'Tree', directory: { mode: 'default' }, binding: null,
      life: 'starting', createdAt: 1, pendingOperationId: 'launch', pendingOperationKind: 'create', worktree,
      pendingSetup: { local: true, setupSessionId: 'agreed', steps: [step], cursor: 0 } }
    await records.put({ ...parent, worktreeLifecycle: WorktreeLifecycleMigration.fromOld(parent)! })
    const checkout = new SvnCheckoutStep({ records, runner, now: () => 5000, svn: {
      status: async () => ({ ok: true, value: { textConflicts: [], otherConflicts: [], changed: [] } }),
      revisionOf: async () => ({ ok: true, value: 42 }), reservedCheck: async () => ({ ok: true, value: { workingCopy: false } }) } })
    expect(await checkout.run('parent', true)).toBe('agreed')
    const workflow = SetupWorkflow.of(records.get('parent')!, records.get('parent')!.pendingSetup!, () => null)
    expect(workflow?.rounds.map((round) => round.title)).toEqual(['Setup'])
  })

  it('plans one setup step that installs every member of a product group in the worktree', async () => {
    const state = directory({})
    const group = directory({
      '.appgroup': '{"kind":"product"}',
      'SrvBackend/package.json': '{}',
      'SrvBackend/pnpm-lock.yaml': '',
      'WebAdmin/package.json': '{}',
      'WebAdmin/pnpm-lock.yaml': '',
      'data/readme.md': '# no manifest\n',
    })
    const worktreePath = join(group, '.worktrees', '045-panel')

    const plan = await (await flowOf(state)).beforePlanFor(group, group, worktreePath)

    expect(plan).toMatchObject({
      kind: 'run',
      skipped: null,
      steps: [{
        scriptId: 'setup',
        commands: [
          { command: 'pnpm install', cwd: join(worktreePath, 'SrvBackend') },
          { command: 'pnpm install', cwd: join(worktreePath, 'WebAdmin') },
        ],
      }],
    })
  })

  it('skips the setup of a group none of whose members it recognises, saying why', async () => {
    const state = directory({})
    const group = directory({ '.appgroup': '{"kind":"product"}', 'data/readme.md': '# no manifest\n' })

    const plan = await (await flowOf(state)).beforePlanFor(group, group, join(group, '.worktrees', '046-x'))

    expect(plan).toMatchObject({ kind: 'skip', reason: expect.stringContaining('no known project family detected') })
  })

  it('preserves legacy group setup and the recorded scope after a record reload', async () => {
    const state = directory({})
    const group = directory({ '.appgroup': '{"kind":"collection"}', 'A/package.json': '{}' })
    const legacy = { kind: 'svn' as const, repositoryRoot: group, worktreePath: join(group, '.worktrees', 'old'), branch: 'url', baseCommit: 'r1' }
    expect(SetupFlow.setupScopeOf(legacy)).toBe('members')
    const flow = await flowOf(state)
    expect(await flow.beforePlanFor(group, group, legacy.worktreePath, SetupFlow.setupScopeOf(legacy)))
      .toMatchObject({ kind: 'run', steps: [{ commands: [{ cwd: join(legacy.worktreePath, 'A') }] }] })
    expect(SetupFlow.setupScopeOf({ ...legacy, setupScope: 'project' })).toBe('project')
    const path = join(state, 'records.json')
    const options = { snapshotsDirectory: join(state, 'snapshots'), report: () => undefined }
    const records = await SessionRecordsStore.load(path, options)
    await records.put({ sessionId: 'scope', kind: 'shell', title: 'scope', directory: { mode: 'adHoc', path: group },
      createdAt: 1, life: 'ended', binding: null, worktree: { ...legacy, setupScope: 'members' } })
    const loaded = await SessionRecordsStore.load(path, options)
    expect(loaded.get('scope')?.worktree?.setupScope).toBe('members')
  })
})
