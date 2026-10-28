import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorktreeConfig } from '../../projectSetup/worktreeConfig'
import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { CommandAgreement } from '../scripts/commandAgreement'
import { CommandTrustStore } from '../scripts/commandTrustStore'
import type { SessionsOpResult } from '../sessionManagerApi.types'
import { FinishScriptsFlow } from './finishScriptsFlow'

describe('lib-orchestrator/sessionManager/lifecycle/finishScriptsFlow', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    flow: FinishScriptsFlow
    store: SessionRecordsStore
    agreement: CommandAgreement
    projectRoot: string
    worktreePath: string
    launched: string[]
    reports: string[]
    continued: string[]
    refusal: { value: SessionsOpResult<never> | null }
    /** What the Host answers a launch; `ends` is a decided refusal, which ends the run record. */
    launchFailure: { value: { result: SessionsOpResult<never>; ends: boolean } | null }
    clock: { now: number }
  }

  async function harness(options?: { startedAt?: number }): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-finish-scripts-'))
    created.push(root)
    const projectRoot = join(root, 'project')
    const worktreePath = join(projectRoot, '.worktrees', '012-fix')
    mkdirSync(worktreePath, { recursive: true })
    const reports: string[] = []
    const store = await SessionRecordsStore.load(join(root, 'session-records.json'), {
      snapshotsDirectory: join(root, 'snapshots'),
      report: (message) => reports.push(message),
    })
    const agreement = new CommandAgreement({
      trust: CommandTrustStore.load(join(root, 'setup-trust.json'), (message) => reports.push(message)),
    })
    const launched: string[] = []
    const continued: string[] = []
    const refusal: Harness['refusal'] = { value: null }
    const launchFailure: Harness['launchFailure'] = { value: null }
    const clock = { now: 5_000 }
    let minted = 0
    const flow = new FinishScriptsFlow({
      records: store,
      setup: { environmentOf: async () => undefined },
      agreement,
      runs: {
        async launch(run) {
          launched.push(run.sessionId)
          const failure = launchFailure.value
          if (failure === null) return { ok: true, value: undefined }
          if (failure.ends)
            await store.put({ ...run, life: 'ended', pendingOperationId: undefined, pendingOperationKind: undefined, endedAt: clock.now })
          return failure.result
        },
      },
      launch: { startRefusal: async () => refusal.value },
      report: (message) => reports.push(message),
      newId: () => `id-${++minted}`,
      now: () => clock.now,
      startedAt: options?.startedAt ?? 5_000,
    })
    flow.setContinueFinish((parentId) => continued.push(parentId))
    await store.put(parentOf(projectRoot, worktreePath))
    return { flow, store, agreement, projectRoot, worktreePath, launched, reports, continued, refusal, launchFailure, clock }
  }

  function parentOf(projectRoot: string, worktreePath: string): SessionRecord {
    return {
      sessionId: 'p',
      kind: 'shell',
      title: 'i12 fix',
      directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      worktree: { worktreePath, branch: 'jamat/012-fix', baseCommit: 'abc', repositoryRoot: projectRoot },
      binding: null,
      life: 'ended',
      createdAt: 1,
      endedAt: 4_000,
      exitCode: 0,
    }
  }

  function declare(context: Harness, config: unknown): void {
    writeFileSync(join(context.projectRoot, '.worktree.json'), JSON.stringify(config), 'utf8')
  }

  const twoChecks = {
    scripts: {
      after: [
        { name: 'lint', command: 'pnpm lint' },
        { name: 'tests', command: 'pnpm test', cwd: 'packages/app' },
      ],
    },
  }

  async function agreed(context: Harness, config: unknown = twoChecks): Promise<void> {
    declare(context, config)
    const declared = await context.agreement.declared(context.projectRoot)
    if (declared.kind !== 'read' || declared.value === null) throw new Error('the project declares nothing')
    expect(context.agreement.gate(context.projectRoot, declared, declared.value.hash)).toBe(null)
  }

  /** What the reconciler writes once the Host reported the run's end. */
  async function ended(context: Harness, runId: string, exitCode: number): Promise<void> {
    const run = context.store.get(runId)
    if (!run) throw new Error(`no run ${runId}`)
    await context.store.put({ ...run, life: 'ended', binding: null, pendingOperationId: undefined, pendingOperationKind: undefined, exitCode, endedAt: context.clock.now })
  }

  it('answers none for a project without after scripts, and launches nothing', async () => {
    const context = await harness()
    declare(context, { setup: ['pnpm install'] })

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'none' })
    expect(context.launched).toEqual([])
    expect(context.store.get('p')?.finishChecks).toBeUndefined()
  })

  it('starts the chain at its first step, and a press while it runs does nothing more', async () => {
    const context = await harness()
    await agreed(context)

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'started' })
    const checks = context.store.get('p')?.finishChecks
    expect(checks).toMatchObject({ runId: 'id-1', cursor: 0, startedAt: 5_000 })
    expect(checks?.steps.map((step) => step.name)).toEqual(['lint', 'tests'])
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      title: 'lint 012-fix',
      commands: [{ command: 'pnpm lint', cwd: context.worktreePath }],
      scriptOf: { sessionId: 'p', phase: 'after', scriptId: 'declared', name: 'lint', stepKey: checks?.steps[0].key },
    }))
    expect(context.launched).toEqual(['id-1'])

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'running' })
    expect(context.launched).toEqual(['id-1'])
  })

  it('asks for the agreement first, and the same press with the hash starts the chain', async () => {
    const context = await harness()
    declare(context, twoChecks)

    const asked = await context.flow.gate('p', undefined, null)
    if (asked.kind !== 'refused' || asked.result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(asked)}`)
    expect(asked.result).toMatchObject({
      code: 'setup-not-acknowledged',
      setup: { commands: ['after lint: pnpm lint', 'after tests (in packages/app): pnpm test'] },
    })
    expect(context.launched).toEqual([])

    expect(await context.flow.gate('p', asked.result.setup?.hash, null)).toEqual({ kind: 'started' })
    expect(context.launched).toEqual(['id-1'])
  })

  it('refuses a damaged scripts key as invalid-spec', async () => {
    const context = await harness()
    declare(context, { scripts: { after: [{ name: 'tests', comand: 'pnpm test' }] } })

    expect(await context.flow.gate('p', undefined, null)).toMatchObject({
      kind: 'refused',
      result: { ok: false, code: 'invalid-spec' },
    })
    expect(context.launched).toEqual([])
  })

  it.each([
    ['broken JSON', '{ "scripts": '],
    ['a file that is not an object', '["pnpm test"]'],
  ])('refuses %s as invalid-spec, and keeps the failure an earlier press found', async (_label, raw) => {
    const context = await harness()
    await agreed(context)
    await context.flow.gate('p', undefined, null)
    await ended(context, 'id-1', 1)
    await context.flow.applyFailed('p', 'the lint check exited with 1')
    writeFileSync(join(context.projectRoot, '.worktree.json'), raw, 'utf8')

    expect(await context.flow.gate('p', undefined, null)).toMatchObject({
      kind: 'refused',
      result: { ok: false, code: 'invalid-spec', detail: expect.stringContaining('.worktree.json') },
    })
    expect(context.store.get('p')?.finishChecks?.result).toMatchObject({ kind: 'failed' })
    expect(context.launched).toEqual(['id-1'])
  })

  it('refuses a file that cannot be read as invalid-spec', async () => {
    const context = await harness()
    // A directory where the file should be: present, and unreadable on every platform.
    mkdirSync(join(context.projectRoot, '.worktree.json'))

    expect(await context.flow.gate('p', undefined, null)).toMatchObject({
      kind: 'refused',
      result: { ok: false, code: 'invalid-spec', detail: expect.stringContaining('could not be read') },
    })
  })

  it('answers none for a project without a .worktree.json', async () => {
    const context = await harness()

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'none' })
  })

  // The steps that run come from the read whose hash the gate checked.
  it('reads the file once per press', async () => {
    const context = await harness()
    await agreed(context)
    const load = vi.spyOn(WorktreeConfig, 'load')

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'started' })
    expect(load).toHaveBeenCalledTimes(1)
    load.mockRestore()
  })

  // The run stays pending and the reconciler replays it, so a pass can still continue the Finish.
  it('answers started when the Host could not answer the launch', async () => {
    const context = await harness()
    await agreed(context)
    context.launchFailure.value = { result: { ok: false, code: 'host-unreachable', detail: 'no descriptor' }, ends: false }

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'started' })
    expect(context.store.get('p')?.finishChecks).toMatchObject({ runId: 'id-1', cursor: 0 })
  })

  it('answers the refusal when the Host decided against the launch', async () => {
    const context = await harness()
    await agreed(context)
    const refused: SessionsOpResult<never> = { ok: false, code: 'op-rejected', detail: 'launch.cwd must be an existing directory' }
    context.launchFailure.value = { result: refused, ends: true }

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'refused', result: refused })
  })

  // An SVN Finish without its commit dialog answers that before anybody waits for the checks.
  it('refuses with what the finisher would answer before any check runs', async () => {
    const context = await harness()
    await agreed(context)
    const unavailable: SessionsOpResult<never> = { ok: false, code: 'review-unavailable', detail: 'no dialog' }

    expect(await context.flow.gate('p', undefined, unavailable)).toEqual({ kind: 'refused', result: unavailable })
    expect(context.launched).toEqual([])
    expect(context.store.list().map((record) => record.sessionId)).toEqual(['p'])
  })

  it('refuses a launch into a worktree a finish holds or that is gone', async () => {
    const context = await harness()
    await agreed(context)
    context.refusal.value = { ok: false, code: 'worktree-removed', detail: 'gone' }

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'refused', result: context.refusal.value })
    expect(context.launched).toEqual([])
  })

  it('refuses a press that is no longer the finish of a worktree', async () => {
    const context = await harness()
    await agreed(context)
    await context.store.put({ ...context.store.get('p')!, life: 'live', binding: { hostInstanceId: 'h', generation: 1 } })

    expect(await context.flow.gate('p', undefined, null)).toMatchObject({
      kind: 'refused',
      result: { ok: false, code: 'live-refused', detail: expect.stringContaining('stop') },
    })
  })

  it('waits for the run record to end, runs each step, and continues the Finish once after the last', async () => {
    const context = await harness()
    await agreed(context)
    await context.flow.gate('p', undefined, null)
    await context.store.put({ ...context.store.get('id-1')!, life: 'live', binding: { hostInstanceId: 'h', generation: 1 } })

    // The Host's dead runtime is judged in the pass that marks the run's own record ended.
    expect(await context.flow.applyPassed('p')).toBe(null)
    expect(context.store.get('p')?.finishChecks).toMatchObject({ runId: 'id-1', cursor: 0 })

    await ended(context, 'id-1', 0)
    expect(await context.flow.applyPassed('p')).toEqual({ kind: 'script-succeeded', sessionId: 'p', gate: 'finish' })
    expect(context.store.get('p')?.finishChecks).toMatchObject({ runId: 'id-3', cursor: 1 })
    expect(context.store.get('id-3')?.commands).toEqual([{ command: 'pnpm test', cwd: join(context.worktreePath, 'packages', 'app') }])
    expect(context.launched).toEqual(['id-1', 'id-3'])
    expect(context.continued).toEqual([])

    await ended(context, 'id-3', 0)
    context.clock.now = 6_000
    expect(await context.flow.applyPassed('p')).toEqual({ kind: 'script-succeeded', sessionId: 'p', gate: 'finish' })
    expect(context.store.get('p')?.finishChecks?.result).toEqual({ kind: 'passed', at: 6_000 })
    expect(context.continued).toEqual(['p'])
    expect(await context.flow.applyPassed('p')).toBe(null)
    expect(context.continued).toEqual(['p'])

    // The next press finds the pass and lets the finisher run.
    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'passed' })
    expect(context.launched).toEqual(['id-1', 'id-3'])
  })

  it('does not continue a chain an earlier client process started, and says so once', async () => {
    const context = await harness({ startedAt: 9_000 })
    await agreed(context, { scripts: { after: [{ name: 'tests', command: 'pnpm test' }] } })
    await context.flow.gate('p', undefined, null)
    await ended(context, 'id-1', 0)

    await context.flow.applyPassed('p')
    expect(context.continued).toEqual([])
    expect(context.reports).toEqual(['Session p: its Finish checks passed; press Finish to continue'])
    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'passed' })
  })

  it('writes a failure with one report, and the next press runs the whole chain again', async () => {
    const context = await harness()
    await agreed(context)
    await context.flow.gate('p', undefined, null)
    await ended(context, 'id-1', 0)
    await context.flow.applyPassed('p')
    await ended(context, 'id-3', 1)

    expect(await context.flow.applyFailed('p', 'the tests check exited with 1')).toBe(true)
    expect(context.store.get('p')?.finishChecks).toMatchObject({
      runId: 'id-3',
      cursor: 1,
      result: { kind: 'failed', reason: 'the tests check exited with 1' },
    })
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain('its check tests failed (the tests check exited with 1)')
    expect(await context.flow.applyFailed('p', 'again')).toBe(false)
    expect(context.continued).toEqual([])

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'started' })
    expect(context.store.get('p')?.finishChecks).toMatchObject({ runId: 'id-5', cursor: 0 })
    expect(context.store.get('p')?.finishChecks?.result).toBeUndefined()
  })

  it('runs the chain again when its steps changed or the session ran since it passed', async () => {
    const context = await harness()
    await agreed(context, { scripts: { after: [{ name: 'tests', command: 'pnpm test' }] } })
    await context.flow.gate('p', undefined, null)
    await ended(context, 'id-1', 0)
    await context.flow.applyPassed('p')
    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'passed' })

    await context.store.put({ ...context.store.get('p')!, endedAt: 7_000 })
    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'started' })
    await ended(context, 'id-3', 0)
    await context.flow.applyPassed('p')

    await agreed(context, { scripts: { after: [{ name: 'tests', command: 'pnpm test --run' }] } })
    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'started' })
  })

  it('clears an earlier chain once the project declares no after scripts', async () => {
    const context = await harness()
    await agreed(context)
    await context.flow.gate('p', undefined, null)
    await ended(context, 'id-1', 1)
    await context.flow.applyFailed('p', 'the lint check exited with 1')
    declare(context, {})

    expect(await context.flow.gate('p', undefined, null)).toEqual({ kind: 'none' })
    expect(context.store.get('p')?.finishChecks).toBeUndefined()
  })
})
