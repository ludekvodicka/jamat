import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import type { SessionsOpResult } from '../sessionManagerApi.types'
import { InnerRunFlow } from './innerRunFlow'

describe('lib-orchestrator/sessionManager/lifecycle/innerRunFlow', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    flow: InnerRunFlow
    store: SessionRecordsStore
    place: string
    launched: string[]
    /** What the launch answers; a decided refusal also ends the run, the way the launcher does. */
    answer: { value: SessionsOpResult; decided: boolean }
  }

  async function harness(parent?: Partial<SessionRecord>): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-inner-runs-'))
    created.push(root)
    const place = join(root, 'project')
    mkdirSync(join(place, 'packages', 'app'), { recursive: true })
    writeFileSync(join(place, 'README.md'), 'a file, not a directory', 'utf8')
    const store = await SessionRecordsStore.load(join(root, 'session-records.json'), {
      snapshotsDirectory: join(root, 'snapshots'),
      report: () => {},
    })
    const launched: string[] = []
    const answer: Harness['answer'] = { value: { ok: true, value: undefined }, decided: true }
    let minted = 0
    const flow = new InnerRunFlow({
      records: store,
      runs: {
        async launch(run) {
          launched.push(run.sessionId)
          if (!answer.value.ok && answer.decided)
            await store.put({ ...run, life: 'ended', pendingOperationId: undefined, pendingOperationKind: undefined })
          return answer.value
        },
      },
      newId: () => `id-${++minted}`,
      now: () => 7_000,
    })
    await store.put({
      sessionId: 'p',
      kind: 'shell',
      title: 'i12 fix',
      directory: { mode: 'adHoc', path: place },
      binding: { hostInstanceId: 'h', generation: 1 },
      life: 'live',
      createdAt: 1,
      ...parent,
    })
    return { flow, store, place, launched, answer }
  }

  function refusalOf(result: SessionsOpResult<unknown>): string {
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('invalid-spec')
    return result.detail
  }

  function requested(context: Harness, sessionId: string, life: SessionRecord['life']): SessionRecord {
    return {
      sessionId,
      kind: 'shell',
      title: 'tests',
      directory: { mode: 'adHoc', path: context.place },
      commands: [{ command: 'pnpm test', cwd: context.place }],
      scriptOf: { sessionId: 'p', phase: 'inner', scriptId: 'requested', name: 'tests' },
      binding: life === 'live' ? { hostInstanceId: 'h', generation: 1 } : null,
      life,
      createdAt: 2,
    }
  }

  it('writes the run under the session, launches it and answers its id', async () => {
    const context = await harness()

    expect(await context.flow.start('p', { command: 'pnpm test', cwd: 'packages/app', title: 'tests' }))
      .toEqual({ ok: true, value: { runId: 'id-1' } })
    expect(context.launched).toEqual(['id-1'])
    expect(context.store.get('id-1')).toEqual({
      sessionId: 'id-1',
      kind: 'shell',
      title: 'tests',
      directory: { mode: 'adHoc', path: join(context.place, 'packages', 'app') },
      commands: [{ command: 'pnpm test', cwd: join(context.place, 'packages', 'app') }],
      scriptOf: { sessionId: 'p', phase: 'inner', scriptId: 'requested', name: 'tests' },
      binding: null,
      life: 'starting',
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
      createdAt: 7_000,
    })
  })

  it('runs in the session directory without a cwd, and is named by its command without a title', async () => {
    const context = await harness()

    expect(await context.flow.start('p', { command: '  pnpm lint --fix  ' })).toEqual({ ok: true, value: { runId: 'id-1' } })
    expect(context.store.get('id-1')).toMatchObject({
      title: 'pnpm lint --fix',
      commands: [{ command: '  pnpm lint --fix  ', cwd: context.place }],
      scriptOf: { name: 'pnpm lint --fix' },
    })
  })

  it('takes an absolute directory inside the session directory', async () => {
    const context = await harness()
    const inside = join(context.place, 'packages')

    expect(await context.flow.start('p', { command: 'pnpm test', cwd: inside })).toEqual({ ok: true, value: { runId: 'id-1' } })
    expect(context.store.get('id-1')?.commands).toEqual([{ command: 'pnpm test', cwd: inside }])
  })

  // The review's validation run starts at the worktree root, above a session started in a subdirectory.
  it('takes the whole worktree of a session started below its root, and starts in that subdirectory without a cwd', async () => {
    const context = await harness({
      worktree: { kind: 'svn', worktreePath: 'Q:/pending', branch: 'http://svn/app', baseCommit: 'r7', repositoryRoot: 'Q:/main', cwdSubpath: 'packages/app' },
    })
    const parent = context.store.get('p')!
    await context.store.put({ ...parent, worktree: { ...parent.worktree!, worktreePath: context.place } })

    expect(await context.flow.start('p', { command: 'node show.js', cwd: context.place })).toEqual({ ok: true, value: { runId: 'id-1' } })
    expect(context.store.get('id-1')?.commands).toEqual([{ command: 'node show.js', cwd: context.place }])
    expect(await context.flow.start('p', { command: 'pnpm test' })).toEqual({ ok: true, value: { runId: 'id-3' } })
    expect(context.store.get('id-3')?.commands).toEqual([{ command: 'pnpm test', cwd: join(context.place, 'packages', 'app') }])
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', cwd: '../../..' })))
      .toContain(`is outside the session's worktree ${context.place}`)
  })

  it('answers the failure of a launch the Host refused', async () => {
    const context = await harness()
    context.answer.value = { ok: false, code: 'op-rejected', detail: 'launch.cwd must exist' }

    expect(await context.flow.start('p', { command: 'pnpm test' }))
      .toEqual({ ok: false, code: 'op-rejected', detail: 'launch.cwd must exist' })
    expect(context.launched).toEqual(['id-1'])
  })

  // The Host may have started it although its answer never came: the next listing decides.
  it('answers the run id of a launch the Host did not decide, which stays pending', async () => {
    const context = await harness()
    context.answer.value = { ok: false, code: 'host-unreachable', detail: 'timed out' }
    context.answer.decided = false

    expect(await context.flow.start('p', { command: 'pnpm test' })).toEqual({ ok: true, value: { runId: 'id-1' } })
    expect(context.store.get('id-1')).toMatchObject({ life: 'starting', pendingOperationId: 'id-2' })
  })

  it('refuses an unknown session as not found', async () => {
    const context = await harness()

    expect(await context.flow.start('nobody', { command: 'pnpm test' }))
      .toEqual({ ok: false, code: 'not-found', detail: 'No session nobody' })
  })

  it('refuses a session that is not running, and a run', async () => {
    for (const life of ['ended', 'lost', 'starting'] as const) {
      const context = await harness({ life, binding: null })
      expect(refusalOf(await context.flow.start('p', { command: 'pnpm test' })))
        .toBe('Session p is not running; a requested run belongs to a running session')
    }
    const context = await harness({ scriptOf: { sessionId: 'q', phase: 'inner', scriptId: 'requested', name: 'x' } })
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test' })))
      .toBe('Session p is a script run, and a run has no runs of its own')
  })

  it('refuses a directory outside the session directory, a missing one and a file', async () => {
    const context = await harness()

    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', cwd: '..' }))).toContain('is outside the session\'s directory')
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', cwd: tmpdir() }))).toContain('is outside the session\'s directory')
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', cwd: `${context.place}-sibling` })))
      .toContain('is outside the session\'s directory')
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', cwd: 'packages/missing' }))).toContain('cannot be used')
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', cwd: 'README.md' }))).toContain('is not a directory')
    expect(context.launched).toEqual([])
    expect(context.store.list().map((record) => record.sessionId)).toEqual(['p'])
  })

  it('refuses a directory a link inside the session directory leads out to', async (test) => {
    const context = await harness()
    const outside = mkdtempSync(join(tmpdir(), 'jamat-v3-inner-runs-outside-'))
    created.push(outside)
    try {
      symlinkSync(outside, join(context.place, 'escape'), 'junction')
    } catch {
      test.skip()
    }

    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', cwd: 'escape' })))
      .toContain('is outside the session\'s directory')
    expect(context.launched).toEqual([])
  })

  it('refuses an empty command, one too long and one over two lines', async () => {
    const context = await harness()

    expect(refusalOf(await context.flow.start('p', { command: '   ' }))).toBe('The command is empty')
    expect(refusalOf(await context.flow.start('p', { command: 'x'.repeat(4_097) })))
      .toBe('The command has 4097 characters; at most 4096 are allowed')
    expect(await context.flow.start('p', { command: 'x'.repeat(4_096) })).toEqual({ ok: true, value: { runId: 'id-1' } })
    for (const command of ['pnpm test\nrm -rf .', 'pnpm test\r', 'pnpm\0test'])
      expect(refusalOf(await context.flow.start('p', { command }))).toBe('The command must be one line, without NUL, CR or LF')
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', title: 'a\nb' })))
      .toBe('The title must be one line, without NUL, CR or LF')
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test', title: 't'.repeat(81) })))
      .toBe('The title has 81 characters; at most 80 are allowed')
  })

  it('refuses a fifth live run of one session, and counts only live and starting ones', async () => {
    const context = await harness()
    await context.store.put(requested(context, 'r1', 'live'))
    await context.store.put(requested(context, 'r2', 'live'))
    await context.store.put({ ...requested(context, 'r3', 'starting'), pendingOperationId: 'op', pendingOperationKind: 'create' })
    await context.store.put(requested(context, 'r4', 'ended'))
    await context.store.put({ ...requested(context, 'other', 'live'), scriptOf: { sessionId: 'q', phase: 'inner', scriptId: 'requested', name: 'x' } })

    expect(await context.flow.start('p', { command: 'pnpm test' })).toEqual({ ok: true, value: { runId: 'id-1' } })
    expect(refusalOf(await context.flow.start('p', { command: 'pnpm test' })))
      .toBe('Session p already runs 4 requested runs; wait for one to end or stop it')
    expect(context.launched).toEqual(['id-1'])
  })
})
