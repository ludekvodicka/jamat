import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeRef, RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import type { HostCallFailure } from '../../hostClient/hostClient.types'
import type { SessionRecord, SessionRecordScriptRun } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { ScriptLogStore } from './scriptLogStore'
import { ScriptLogText } from './scriptLogText'
import { type ScriptCollapsed, type ScriptsHostPort, SessionScriptsManager } from './sessionScriptsManager'

describe('lib-orchestrator/sessionManager/scripts/sessionScriptsManager', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    manager: SessionScriptsManager
    host: ScriptsHostPort
    store: SessionRecordsStore
    recordsFile: string
    logs: ScriptLogStore
    logsDirectory: string
    snapshotsDirectory: string
    /** Dead runtimes the Host still holds, with the rows their screens show. */
    runtimes: Map<string, { info: RuntimeSessionInfo; rows: string[] }>
    /** Answers every Host call when set. */
    failure: { value: HostCallFailure | null }
    calls: { name: string; target: RuntimeRef }[]
    collapsed: ScriptCollapsed[]
    reports: string[]
    clock: { now: number }
  }

  async function harness(): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-session-scripts-'))
    created.push(root)
    const snapshotsDirectory = join(root, 'session-snapshots')
    const reports: string[] = []
    const recordsFile = join(root, 'session-records.json')
    const store = await SessionRecordsStore.load(recordsFile, {
      snapshotsDirectory,
      report: (message) => reports.push(message),
    })
    const logsDirectory = join(root, 'script-logs')
    const logs = new ScriptLogStore(logsDirectory)
    const runtimes: Harness['runtimes'] = new Map()
    const failure: Harness['failure'] = { value: null }
    const calls: Harness['calls'] = []
    const collapsed: ScriptCollapsed[] = []
    const clock = { now: 10_000 }
    const ack = (target: RuntimeRef) =>
      ({ ok: true as const, value: { servedByHostInstanceId: 'h', target, diagnostic: 'removed' as const } })
    const host: ScriptsHostPort = {
      async runtimeInspect(target) {
        calls.push({ name: 'inspect', target })
        if (failure.value) return failure.value
        const found = runtimes.get(target.runtimeSessionId)
        if (!found) return { ok: false, code: 'op-rejected', status: 404, detail: 'Unknown runtime' }
        return {
          ok: true,
          value: {
            session: found.info,
            projection: {
              runtimeSessionId: target.runtimeSessionId,
              generation: 1,
              outputEpoch: 1,
              outputSeq: 1,
              screen: '',
              screenLines: found.rows,
              screenLinesStyled: true,
              cols: 80,
              rows: 24,
              alive: false,
              lastOutputAt: null,
            },
          },
        }
      },
      async runtimeStop(target) {
        calls.push({ name: 'stop', target })
        if (failure.value) return failure.value
        return ack(target)
      },
      async runtimeRemove(target) {
        calls.push({ name: 'remove', target })
        runtimes.delete(target.runtimeSessionId)
        return ack(target)
      },
    }
    return {
      host,
      manager: new SessionScriptsManager({
        records: store,
        host,
        logs,
        onCollapsed: (event) => collapsed.push(event),
        report: (message) => reports.push(message),
        now: () => clock.now,
      }),
      store,
      recordsFile,
      logs,
      logsDirectory,
      snapshotsDirectory,
      runtimes,
      failure,
      calls,
      collapsed,
      reports,
      clock,
    }
  }

  function record(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId,
      kind: 'shell',
      title: `Session ${sessionId}`,
      directory: { mode: 'default' },
      binding: null,
      life: 'live',
      createdAt: 1,
      ...overrides,
    }
  }

  /** An install that ran on the Host and exited; the parent `p` no longer waits on it. */
  function install(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return record(sessionId, {
      title: `Setup ${sessionId}`,
      life: 'ended',
      binding: { hostInstanceId: 'h', generation: 1 },
      exitCode: 0,
      endedAt: 20_000,
      createdAt: 15_000,
      commands: [{ command: 'pnpm install', cwd: 'C:\\w\\fix' }],
      scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'setup', name: 'setup' },
      ...overrides,
    })
  }

  function dead(id: string, rows: string[]): { info: RuntimeSessionInfo; rows: string[] } {
    return {
      info: {
        runtimeSessionId: id,
        generation: 1,
        alive: false,
        exitCode: 0,
        cols: 80,
        rows: 24,
        outputSeq: 1,
        outputEpoch: 1,
        lastOutputAt: null,
        startedAt: 1,
      },
      rows,
    }
  }

  function historyOf(context: Harness): readonly SessionRecordScriptRun[] {
    return context.store.get('p')?.scriptRuns ?? []
  }

  it('saves the log off the dead runtime and writes a succeeded entry on the parent', async () => {
    const context = await harness()
    await context.store.put(record('p', { title: 'Fix the bug' }))
    await context.store.put(install('s'))
    context.runtimes.set('s', dead('s', ['\u001b[2mresolving\u001b[22m', 'done in 3s']))

    expect(await context.manager.settle('s')).toBe(true)

    const [entry] = historyOf(context)
    expect(entry).toEqual({
      runId: 's',
      phase: 'before',
      scriptId: 'setup',
      name: 'setup',
      title: 'Setup s',
      commands: ['pnpm install'],
      startedAt: 15_000,
      endedAt: 20_000,
      exitCode: 0,
      outcome: 'succeeded',
      log: { state: 'saved', bytes: expect.any(Number), truncated: false },
    })
    expect(context.calls[0]).toEqual({
      name: 'inspect',
      target: { hostInstanceId: 'h', runtimeSessionId: 's', generation: 1 },
    })
    const text = readFileSync(context.logs.pathOf('p', 's'), 'utf8')
    expect(text).toContain('Parent:    Fix the bug (p)')
    expect(text).toContain('  pnpm install')
    expect(text).toContain('Duration:  5.0 s')
    expect(text).toContain('resolving\ndone in 3s\n')
    expect(text).not.toContain('\u001b')
    // The run's own record is not the manager's to touch here: collapsing is a separate step.
    expect(context.store.get('s')).not.toBeNull()
  })

  it('writes a failed entry with the exit code and the reason', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s', { exitCode: 1 }))
    context.runtimes.set('s', dead('s', ['ERR_PNPM']))

    expect(await context.manager.settle('s')).toBe(true)
    expect(historyOf(context)[0]).toEqual(expect.objectContaining({
      outcome: 'failed',
      exitCode: 1,
      reason: 'the setup ended with 1',
    }))
    expect(readFileSync(context.logs.pathOf('p', 's'), 'utf8')).toContain('Reason:    the setup ended with 1')
  })

  it('keeps the step a chain run attempted, names a declared step, and answers which steps succeeded', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s', {
      scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'setup', name: 'setup', stepKey: 'k1' },
    }))
    await context.store.put(install('c', {
      createdAt: 21_000,
      endedAt: 22_000,
      exitCode: 2,
      scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'declared', name: 'codegen', stepKey: 'k2' },
    }))
    await context.store.put(install('o', { createdAt: 23_000, endedAt: 24_000 }))

    for (const runId of ['s', 'c', 'o']) expect(await context.manager.settle(runId)).toBe(true)
    expect(historyOf(context).map((entry) => [entry.runId, entry.stepKey, entry.reason])).toEqual([
      ['s', 'k1', undefined],
      ['c', 'k2', 'the codegen script ended with 2'],
      ['o', undefined, undefined],
    ])
    const parent = context.store.get('p')!
    expect([...context.manager.succeededKeys(parent, 'before', 0)]).toEqual(['k1'])
    expect([...context.manager.succeededKeys(parent, 'before', 15_001)]).toEqual([])
    expect([...context.manager.succeededKeys(parent, 'after', 0)]).toEqual([])
  })

  it('reads a Host without the runtime as a restart, and settles a run only once', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s'))

    expect(await context.manager.settle('s')).toBe(true)
    expect(await context.manager.settle('s')).toBe(false)

    expect(historyOf(context)).toHaveLength(1)
    expect(historyOf(context)[0].log)
      .toEqual({ state: 'unavailable', reason: 'the Host restarted before the output was saved' })
    expect(existsSync(join(context.logsDirectory, 'p'))).toBe(false)
  })

  it('says a run that ended before this client started ended before logs were kept', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s', { endedAt: 9_000 }))

    expect(await context.manager.settle('s')).toBe(true)
    expect(historyOf(context)[0].log).toEqual({ state: 'unavailable', reason: 'ended before this build kept logs' })
  })

  it('says why a run the Host never ran has no log, and asks again when the Host cannot answer', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('never', { binding: null, exitCode: undefined, endedReason: 'launch.cwd is gone' }))
    await context.store.put(install('later'))
    context.failure.value = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }

    expect(await context.manager.settle('never')).toBe(true)
    expect(await context.manager.settle('later')).toBe(false)

    expect(historyOf(context).map((entry) => [entry.runId, entry.outcome, entry.log])).toEqual([
      ['never', 'failed', { state: 'unavailable', reason: 'the Host never ran it' }],
    ])
  })

  /** Settles `s0` to `s<count - 1>`; every run collapses after its settle except the ones in `rows`. */
  async function settledRuns(context: Harness, count: number, rows: readonly string[] = []): Promise<void> {
    await context.store.put(record('p'))
    for (let index = 0; index < count; index += 1) {
      const id = `s${index}`
      await context.store.put(install(id))
      context.runtimes.set(id, dead(id, [`run ${index}`]))
      expect(await context.manager.settle(id)).toBe(true)
      if (!rows.includes(id)) expect(await context.store.remove(id, { recoveryPoint: false })).toBe(true)
    }
  }

  it('keeps ten entries, dropping the oldest with its log', async () => {
    const context = await harness()
    await settledRuns(context, 11)

    expect(historyOf(context).map((entry) => entry.runId)).toEqual(
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'])
    expect(existsSync(context.logs.pathOf('p', 's0'))).toBe(false)
    expect(existsSync(context.logs.pathOf('p', 's1'))).toBe(true)
  })

  // The entry is what marks its run settled; without it the run would be settled again and evict another.
  it('never drops the entry of a run whose record is still a row', async () => {
    const context = await harness()
    await settledRuns(context, 12, ['s0'])

    expect(historyOf(context).map((entry) => entry.runId)).toEqual(
      ['s0', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'])
    expect(existsSync(context.logs.pathOf('p', 's0'))).toBe(true)
    expect(existsSync(context.logs.pathOf('p', 's2'))).toBe(false)
    expect(await context.manager.settle('s0')).toBe(false)
  })

  it('lets the history pass the cap while every older entry still names a row', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    for (let index = 0; index < 11; index += 1) {
      const id = `s${index}`
      await context.store.put(install(id))
      context.runtimes.set(id, dead(id, [`run ${index}`]))
      expect(await context.manager.settle(id)).toBe(true)
    }

    expect(historyOf(context)).toHaveLength(11)
  })

  it('collapses a run without a recovery point, removing its dead runtime, and names the handoff', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s'))
    await context.store.put(install('r', {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'fork', oneShot: true },
      scriptOf: { sessionId: 'p', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
    }))
    await context.store.put(install('orphan', { scriptOf: { sessionId: 'gone', phase: 'before', scriptId: 'setup', name: 'setup' } }))
    await context.store.put(install('running', { life: 'live' }))

    for (const id of ['s', 'r', 'orphan']) expect(await context.manager.collapse(id)).toBe(true)
    expect(await context.manager.collapse('running')).toBe(false)

    expect(context.store.list().map((entry) => entry.sessionId)).toEqual(['p', 'running'])
    expect(context.calls.filter((call) => call.name === 'remove').map((call) => call.target.runtimeSessionId))
      .toEqual(['s', 'r', 'orphan'])
    expect(context.collapsed).toEqual([
      { runId: 's', parentId: 'p', handoff: 'parent-tab', handoffTo: 'p' },
      { runId: 'r', parentId: 'p', handoff: 'close', handoffTo: 'p' },
      { runId: 'orphan', parentId: 'gone', handoff: 'close', handoffTo: 'gone' },
    ])
    expect(existsSync(context.snapshotsDirectory)).toBe(false)
  })

  it('hands a collapsed chain step to the next step its parent waits on', async () => {
    const context = await harness()
    await context.store.put(record('p', {
      life: 'starting',
      pendingOperationId: 'op',
      pendingOperationKind: 'create',
      pendingSetup: { setupSessionId: 'next' },
    }))
    await context.store.put(install('s'))
    await context.store.put(install('next', { life: 'live' }))

    expect(await context.manager.collapse('s')).toBe(true)

    expect(context.collapsed).toEqual([{ runId: 's', parentId: 'p', handoff: 'parent-tab', handoffTo: 'next' }])
  })

  it('stops the live runs of a parent and hands back the rest for its removal', async () => {
    const context = await harness()
    await context.store.put(record('p', { life: 'ended' }))
    await context.store.put(install('live', { life: 'live' }))
    await context.store.put(install('ended'))
    await context.store.put(install('unanswered', { life: 'starting', binding: null, pendingOperationId: 'op', pendingOperationKind: 'create' }))
    await context.store.put(install('other', { scriptOf: { sessionId: 'q', phase: 'before', scriptId: 'setup', name: 'setup' } }))

    const { removeWith } = await context.manager.cascadeOf(context.store.get('p') ?? record('p'))

    expect(removeWith).toEqual(['ended', 'unanswered'])
    expect(context.calls.map((call) => [call.name, call.target.runtimeSessionId]))
      .toEqual([['stop', 'live'], ['remove', 'ended']])
    expect(context.store.get('live')?.stopRequested).toBe(true)
  })

  it('reports a stop the Host refused once, leaves a gated run unmarked and asks again on its pace', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('live', { life: 'live' }))
    context.failure.value = { ok: false, code: 'op-rejected', status: 409, detail: 'lease lost' }
    const stops = () => context.calls.filter((call) => call.name === 'stop').length

    expect(await context.manager.stopRun('live')).toBe(false)
    expect(context.store.get('live')?.stopRequested).toBeUndefined()
    // The wait after the first refusal is none, after the second two seconds.
    expect(await context.manager.stopRun('live')).toBe(false)
    expect(await context.manager.stopRun('live')).toBe(false)
    expect(stops()).toBe(2)
    context.clock.now += 2_000
    expect(await context.manager.stopRun('live')).toBe(false)
    expect(stops()).toBe(3)
    expect(context.reports).toEqual([expect.stringContaining('lease lost')])

    context.failure.value = null
    context.clock.now += 60_000
    expect(await context.manager.stopRun('live')).toBe(true)
    expect(context.store.get('live')?.stopRequested).toBe(true)
    // Confirmed: the exit the Host reports next moves the run on, so it is not asked again.
    expect(await context.manager.stopRun('live')).toBe(false)
    expect(stops()).toBe(4)
  })

  // Nothing waits on its verdict, and a killed POSIX process reports 0: unmarked, it would read as a success.
  it('marks a requested run stopped although the Host refused its stop', async () => {
    const context = await harness()
    await context.store.put(record('p', { life: 'ended' }))
    await context.store.put(install('r', {
      life: 'live',
      scriptOf: { sessionId: 'p', phase: 'inner', scriptId: 'requested', name: 'dev' },
    }))
    context.failure.value = { ok: false, code: 'op-rejected', status: 500, detail: 'did not confirm its death' }

    expect(await context.manager.stopRun('r')).toBe(false)
    expect(context.store.get('r')?.stopRequested).toBe(true)
  })

  it('dismisses a run by settling it first, and refuses a live one', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s', { exitCode: 1 }))
    await context.store.put(install('live', { life: 'live' }))

    expect(await context.manager.dismiss('live')).toEqual(expect.objectContaining({ ok: false, code: 'live-refused' }))
    expect(await context.manager.dismiss('nope')).toEqual(expect.objectContaining({ ok: false, code: 'not-found' }))
    expect(await context.manager.dismiss('s')).toEqual({ ok: true, value: undefined })

    expect(context.store.get('s')).toBeNull()
    expect(historyOf(context).map((entry) => [entry.runId, entry.outcome])).toEqual([['s', 'failed']])
  })

  it('refuses to dismiss a run whose history entry could not be written, and dismisses it once it is', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s'))
    context.failure.value = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }

    expect(await context.manager.dismiss('s')).toEqual({
      ok: false,
      code: 'live-refused',
      detail: 'The output of script run s is not saved yet, because the Host could not be asked or the '
        + 'history could not be written; try again in a moment',
    })
    expect(context.store.get('s')).not.toBeNull()

    context.failure.value = null
    expect(await context.manager.dismiss('s')).toEqual({ ok: true, value: undefined })
    expect(historyOf(context).map((entry) => entry.runId)).toEqual(['s'])
  })

  // The last check exited 0 and its gate waits a pass for the record to end: removed now, it would read as gone.
  it('refuses to dismiss a run its gate still names and judges', async () => {
    const context = await harness()
    const steps = [{ key: 'k', scriptId: 'declared' as const, name: 'tests', commands: [{ command: 'pnpm test', cwd: 'C:\\w' }] }]
    await context.store.put(record('p', { life: 'ended', finishChecks: { runId: 'c', steps, cursor: 0, startedAt: 1 } }))
    await context.store.put(install('c', { scriptOf: { sessionId: 'p', phase: 'after', scriptId: 'declared', name: 'tests' } }))

    expect(await context.manager.dismiss('c')).toEqual({
      ok: false,
      code: 'live-refused',
      detail: 'The script run c is still being judged for session p; remove it once its verdict is written',
    })
    expect(context.store.get('c')).not.toBeNull()

    await context.store.update('p', (parent) => ({ ...parent, finishChecks: { ...parent.finishChecks!, result: { kind: 'passed', at: 2 } } }))
    expect(await context.manager.dismiss('c')).toEqual({ ok: true, value: undefined })
  })

  it('proves a saved log only through the parent history that names it', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s'))
    await context.store.put(install('lost'))
    context.runtimes.set('s', dead('s', ['done']))
    await context.manager.settle('s')
    await context.manager.settle('lost')
    // A real file, but the history never named its run.
    await context.logs.write('p', 'stray', 'not settled')

    expect(await context.manager.scriptLogOf('p', 's')).toEqual({ ok: true, value: { path: context.logs.pathOf('p', 's') } })
    expect(await context.manager.scriptLogOf('p', 'stray')).toEqual(expect.objectContaining({ ok: false, code: 'not-found' }))
    expect(await context.manager.scriptLogOf('p', 'lost'))
      .toEqual({ ok: false, code: 'not-found', detail: 'The script run lost has no saved log' })
    expect(await context.manager.scriptLogOf('nobody', 's')).toEqual(expect.objectContaining({ ok: false, code: 'not-found' }))
    rmSync(context.logs.pathOf('p', 's'))
    expect(await context.manager.scriptLogOf('p', 's'))
      .toEqual({ ok: false, code: 'not-found', detail: 'The log of script run s is gone' })
  })

  it('reads the runs of a parent and the saved log text of one, and says why another has none', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s'))
    await context.store.put(install('lost', { createdAt: 16_000 }))
    await context.store.put(install('ended', { createdAt: 17_000 }))
    await context.store.put(install('live', { createdAt: 18_000, life: 'live', exitCode: undefined, endedAt: undefined }))
    context.runtimes.set('s', dead('s', ['all tests passed']))
    await context.manager.settle('s')
    await context.manager.settle('lost')

    const listed = await context.manager.scriptsOf('p')
    expect(listed).toMatchObject({ ok: true, value: { sessionId: 'p', log: null } })
    expect(listed.ok && listed.value.runs.map((run) => run.runId)).toEqual(['live', 'ended', 'lost', 's'])
    expect(listed.ok && 'logDetail' in listed.value).toBe(false)

    const saved = await context.manager.scriptsOf('p', 's')
    expect(saved.ok && saved.value.log).toEqual({ runId: 's', text: expect.stringContaining('all tests passed\n'), truncated: false })
    expect(await context.manager.scriptsOf('p', 'live'))
      .toMatchObject({ ok: true, value: { log: null, logDetail: 'running; read it with terminal peek' } })
    expect(await context.manager.scriptsOf('p', 'ended'))
      .toMatchObject({ ok: true, value: { log: null, logDetail: 'ended and not saved yet; read it again in a moment' } })
    expect(await context.manager.scriptsOf('p', 'lost'))
      .toMatchObject({ ok: true, value: { log: null, logDetail: 'the Host restarted before the output was saved' } })
    rmSync(context.logs.pathOf('p', 's'))
    expect(await context.manager.scriptsOf('p', 's')).toMatchObject({ ok: true, value: { log: null, logDetail: 'the saved log is gone' } })

    expect(await context.manager.scriptsOf('p', 'nope'))
      .toEqual({ ok: false, code: 'not-found', detail: 'Session p has no script run nope' })
    expect(await context.manager.scriptsOf('nobody')).toEqual(expect.objectContaining({ ok: false, code: 'not-found' }))
  })

  it('refuses the log of a parent that was removed', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('s'))
    context.runtimes.set('s', dead('s', ['done']))
    await context.manager.settle('s')
    await context.manager.collapse('s')
    expect((await context.manager.scriptLogOf('p', 's')).ok).toBe(true)

    await context.store.remove('p', { recoveryPoint: false })
    await context.manager.parentRemoved('p')

    expect(await context.manager.scriptLogOf('p', 's')).toEqual({ ok: false, code: 'not-found', detail: 'No session p' })
  })

  describe('script output', () => {
    it('reads live terminal rows and the run state with its terminal target', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s', { life: 'live', exitCode: undefined, endedAt: undefined }))
      context.runtimes.set('s', dead('s', ['installing', 'resolved 20 packages']))
      const inspect = vi.spyOn(context.host, 'runtimeInspect')

      expect(await context.manager.outputOf('p', 's')).toEqual({ ok: true, value: {
        state: 'running',
        source: 'live',
        lines: ['installing', 'resolved 20 packages'],
        terminal: { hostInstanceId: 'h', runtimeSessionId: 's', generation: 1 },
      } })
      expect(inspect).toHaveBeenCalledWith(
        { hostInstanceId: 'h', runtimeSessionId: 's', generation: 1 },
        { rawTailChars: 0, screenScrollbackRows: 1000 },
      )
    })

    it('keeps reading an ended record from the Host until collapse, with its end state and time', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s', { exitCode: 2 }))
      context.runtimes.set('s', dead('s', ['failed']))

      expect(await context.manager.outputOf('p', 's')).toEqual({ ok: true, value: {
        state: 'failed',
        source: 'live',
        lines: ['failed'],
        terminal: { hostInstanceId: 'h', runtimeSessionId: 's', generation: 1 },
        endedAt: 20_000,
      } })
    })

    it('reads a retained failed run from its saved log after the Host instance changes', async () => {
      const context = await harness()
      await context.store.put(record('p', { life: 'ended', pendingSetup: { setupSessionId: 's' } }))
      await context.store.put(install('s', { exitCode: 2 }))
      context.runtimes.set('s', dead('s', ['installation failed']))
      await context.manager.settle('s')
      context.failure.value = { ok: false, code: 'op-rejected', status: 409, detail: 'Host instance mismatch' }

      expect(await context.manager.outputOf('p', 's')).toEqual({ ok: true, value: {
        state: 'failed', source: 'log',
        lines: readFileSync(context.logs.pathOf('p', 's'), 'utf8').split('\n'),
        terminal: null, endedAt: 20_000,
      } })
      expect(context.store.get('s')?.binding).toEqual({ hostInstanceId: 'h', generation: 1 })
    })

    it('keeps the missing saved-log reason for a retained failed run with an unavailable runtime', async () => {
      const context = await harness()
      await context.store.put(record('p', { life: 'ended', pendingSetup: { setupSessionId: 's' } }))
      await context.store.put(install('s', { exitCode: 2 }))
      context.runtimes.set('s', dead('s', ['installation failed']))
      await context.manager.settle('s')
      await context.logs.removeRun('p', 's')
      context.failure.value = { ok: false, code: 'op-rejected', status: 409, detail: 'Host instance mismatch' }

      expect(await context.manager.outputOf('p', 's')).toEqual({ ok: true, value: {
        state: 'failed', source: 'log', lines: [], logReason: 'the saved log is gone',
        terminal: null, endedAt: 20_000,
      } })
    })

    it('preserves a Host mismatch error while the run is still running', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s', { life: 'live', exitCode: undefined, endedAt: undefined }))
      context.failure.value = { ok: false, code: 'op-rejected', status: 409, detail: 'Host instance mismatch' }

      expect(await context.manager.outputOf('p', 's'))
        .toEqual({ ok: false, code: 'op-rejected', detail: 'Host instance mismatch' })
    })

    it('removes Host dim markers before applying the live output UTF-8 cap', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s', { life: 'live', exitCode: undefined, endedAt: undefined }))
      const text = 'ž'.repeat(200)
      const rows = [...Array.from({ length: 650 }, () => `\u001b[2m${text}\u001b[22m`), 'done ✓']
      context.runtimes.set('s', dead('s', rows))

      const reading = await context.manager.outputOf('p', 's')

      expect(reading.ok).toBe(true)
      if (!reading.ok) throw new Error(reading.detail)
      expect(reading.value.lines).toHaveLength(rows.length)
      expect(reading.value.lines[0]).toBe(text)
      expect(reading.value.lines.at(-1)).toBe('done ✓')
      expect(reading.value.lines.some((line) => line.includes('\u001b'))).toBe(false)
      expect(Buffer.byteLength(reading.value.lines.join('\n'), 'utf8')).toBeLessThanOrEqual(ScriptLogText.maxBytesConst)
      expect(rows[0]).toContain('\u001b[2m')
    })

    it('reads the saved log after collapse without a terminal', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s'))
      context.runtimes.set('s', dead('s', ['installed', 'done']))
      await context.manager.settle('s')
      await context.manager.collapse('s')
      context.calls.length = 0

      const reading = await context.manager.outputOf('p', 's')

      expect(reading).toEqual({ ok: true, value: {
        state: 'succeeded',
        source: 'log',
        lines: readFileSync(context.logs.pathOf('p', 's'), 'utf8').split('\n'),
        terminal: null,
        endedAt: 20_000,
      } })
      expect(context.calls).toEqual([])
    })

    it('says why a collapsed run has no saved log', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s', { life: 'lost' }))
      await context.manager.settle('s')
      await context.manager.collapse('s')

      expect(await context.manager.outputOf('p', 's')).toEqual({ ok: true, value: {
        state: 'lost',
        source: 'log',
        lines: [],
        logReason: 'the Host restarted before the output was saved',
        terminal: null,
        endedAt: 20_000,
      } })
    })

    it('says when the saved log disappeared after collapse', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s'))
      context.runtimes.set('s', dead('s', ['done']))
      await context.manager.settle('s')
      await context.manager.collapse('s')
      await context.logs.removeRun('p', 's')

      expect(await context.manager.outputOf('p', 's')).toMatchObject({ ok: true, value: {
        source: 'log', lines: [], logReason: 'the saved log is gone', terminal: null,
      } })
    })

    it('refuses an unknown parent, an unknown run and a run belonging to another parent without inspecting', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(record('other'))
      await context.store.put(install('s'))

      for (const [parentId, runId] of [['missing', 's'], ['p', 'missing'], ['other', 's']])
        expect(await context.manager.outputOf(parentId, runId)).toMatchObject({ ok: false, code: 'not-found' })
      expect(context.calls).toEqual([])
    })

    it('caps live rows and saved log tails at 256 KiB in UTF-8, keeping the newest output', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s'))
      const rows = ['oldest', ...Array.from({ length: 1000 }, () => 'ř'.repeat(200)), 'latest']
      context.runtimes.set('s', dead('s', rows))

      const live = await context.manager.outputOf('p', 's')
      expect(live.ok).toBe(true)
      if (!live.ok) throw new Error(live.detail)
      expect(Buffer.byteLength(live.value.lines.join('\n'), 'utf8')).toBeLessThanOrEqual(ScriptLogText.maxBytesConst)
      expect(live.value.lines).not.toContain('oldest')
      expect(live.value.lines.at(-1)).toBe('latest')

      await context.manager.settle('s')
      await context.manager.collapse('s')
      await context.logs.write('p', 's', rows.join('\n'))
      const saved = await context.manager.outputOf('p', 's')
      expect(saved.ok).toBe(true)
      if (!saved.ok) throw new Error(saved.detail)
      expect(saved.value.source).toBe('log')
      expect(Buffer.byteLength(saved.value.lines.join('\n'), 'utf8')).toBeLessThanOrEqual(ScriptLogText.maxBytesConst)
      expect(saved.value.lines).not.toContain('oldest')
      expect(saved.value.lines.at(-1)).toBe('latest')
      expect(saved.value.lines.join('\n')).not.toContain('\uFFFD')
    })

    it('reads the saved log when collapse removes the record during the Host inspection', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s'))
      context.runtimes.set('s', dead('s', ['done']))
      await context.manager.settle('s')
      vi.spyOn(context.host, 'runtimeInspect').mockImplementationOnce(async () => {
        await context.manager.collapse('s')
        return { ok: false, code: 'op-rejected', status: 404, detail: 'Unknown runtime' }
      })

      expect(await context.manager.outputOf('p', 's')).toMatchObject({ ok: true, value: {
        state: 'succeeded', source: 'log', lines: expect.arrayContaining(['done']), terminal: null,
      } })
    })

    it('reports an unavailable Host and keeps an unbound starting run readable without a terminal', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s'))
      context.failure.value = { ok: false, code: 'host-unreachable', detail: 'offline' }

      expect(await context.manager.outputOf('p', 's')).toEqual({ ok: false, code: 'host-unreachable', detail: 'offline' })

      await context.store.put(install('starting', {
        life: 'starting', binding: null, exitCode: undefined, endedAt: undefined,
        pendingOperationId: 'launch', pendingOperationKind: 'create',
      }))
      expect(await context.manager.outputOf('p', 'starting')).toEqual({ ok: true, value: {
        state: 'running', source: 'live', lines: [], terminal: null, logReason: 'the Host has not started it yet',
      } })
    })
  })

  /** A manager over the records file as the next client process loads it. */
  async function reloaded(context: Harness): Promise<{ manager: SessionScriptsManager; store: SessionRecordsStore }> {
    const store = await SessionRecordsStore.load(context.recordsFile, {
      snapshotsDirectory: context.snapshotsDirectory,
      report: (message) => context.reports.push(message),
    })
    const manager = new SessionScriptsManager({
      records: store,
      host: { runtimeInspect: async () => fail(), runtimeStop: async () => fail(), runtimeRemove: async () => fail() },
      logs: context.logs,
      onCollapsed: () => {},
      report: (message) => context.reports.push(message),
      now: () => context.clock.now,
    })
    return { manager, store }
  }

  /** Log folders `p` and `gone` nothing changed for long, and `recent`; no record names the last two. */
  async function oldLogs(context: Harness): Promise<void> {
    await context.logs.write('p', 'r1', 'kept')
    await context.logs.write('gone', 'r2', 'swept')
    await context.logs.write('recent', 'r3', 'kept: changed within the day')
    for (const parent of ['p', 'gone']) utimesSync(join(context.logsDirectory, parent), 1, 1)
    context.clock.now = Date.now()
  }

  it('sweeps the log folders no record names that nothing changed for a day', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await oldLogs(context)

    await (await reloaded(context)).manager.sweep()

    expect(existsSync(context.logs.pathOf('p', 'r1'))).toBe(true)
    expect(existsSync(join(context.logsDirectory, 'gone'))).toBe(false)
    expect(existsSync(context.logs.pathOf('recent', 'r3'))).toBe(true)
  })

  // An empty list read from nothing says nothing about which sessions exist.
  it('sweeps nothing when the records file is missing, damaged or unreadable', async () => {
    const missing = await harness()
    await oldLogs(missing)
    await missing.manager.sweep()

    const damaged = await harness()
    await oldLogs(damaged)
    writeFileSync(damaged.recordsFile, '{ not json', 'utf8')
    const latched = await reloaded(damaged)
    expect(latched.store.latched).toBe(true)
    await latched.manager.sweep()

    // A directory where the file should be cannot be read, and reads as no records without a latch.
    const unreadable = await harness()
    await oldLogs(unreadable)
    mkdirSync(unreadable.recordsFile)
    const empty = await reloaded(unreadable)
    expect(empty.store.latched).toBe(false)
    await empty.manager.sweep()

    for (const context of [missing, damaged, unreadable])
      expect(existsSync(join(context.logsDirectory, 'gone'))).toBe(true)
  })

  it('removes the logs of a parent that went', async () => {
    const context = await harness()
    await context.logs.write('p', 'r1', 'text')

    await context.manager.parentRemoved('p')

    expect(existsSync(join(context.logsDirectory, 'p'))).toBe(false)
  })

  it('reports the runs settled without a log in one line, once', async () => {
    const context = await harness()
    await context.store.put(record('p'))
    await context.store.put(install('a'))
    await context.store.put(install('b'))
    await context.manager.settle('a')
    await context.manager.settle('b')

    context.manager.reportUnlogged()
    context.manager.reportUnlogged()

    expect(context.reports).toEqual(['2 script runs were settled without a saved log; each history entry says why'])
  })

  describe('the snapshot view', () => {
    it('links a run to its parent and gives a session without runs nothing to draw', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(record('alone'))
      await context.store.put(install('s', { life: 'live', exitCode: undefined, endedAt: undefined }))

      expect(context.manager.infoOf(context.store.get('s') ?? fail()).script)
        .toEqual({ parentId: 'p', phase: 'before', scriptId: 'setup' })
      expect(context.manager.infoOf(context.store.get('alone') ?? fail())).toEqual({})
    })

    it('lists rows and history newest first, one entry for a settled run that is still a row', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('old', { createdAt: 1_000, endedAt: 2_000, exitCode: 1 }))
      await context.manager.settle('old')
      await context.manager.collapse('old')
      await context.store.put(install('settled', { createdAt: 5_000, endedAt: 7_500 }))
      await context.manager.settle('settled')
      await context.store.put(install('ended', { createdAt: 9_000, endedAt: 9_500, exitCode: 3 }))
      await context.store.put(install('running', { createdAt: 12_000, life: 'live', exitCode: undefined, endedAt: undefined }))

      const runs = context.manager.infoOf(context.store.get('p') ?? fail()).scripts?.runs ?? []

      expect(runs.map((run) => [run.runId, run.state, run.row, run.log])).toEqual([
        ['running', 'running', true, 'none'],
        ['ended', 'failed', true, 'none'],
        ['settled', 'succeeded', true, 'unavailable'],
        ['old', 'failed', false, 'unavailable'],
      ])
      expect(runs[0]).toEqual({
        runId: 'running',
        phase: 'before',
        scriptId: 'setup',
        name: 'setup',
        title: 'Setup running',
        state: 'running',
        summary: 'Setup running · running',
        startedAt: 12_000,
        commands: ['pnpm install'],
        row: true,
        log: 'none',
      })
      expect(runs[1]).toMatchObject({ exitCode: 3, endedAt: 9_500, summary: 'Setup ended · failed · exit 3 · 0.5 s' })
      expect(runs[2]).toMatchObject({
        summary: 'Setup settled · succeeded · 2.5 s',
        durationText: '2.5 s',
        logDetail: 'ended before this build kept logs',
      })
    })

    it('composes the same view twice while a run is running', async () => {
      const context = await harness()
      await context.store.put(record('p', { life: 'starting', pendingSetup: { setupSessionId: 's' } }))
      await context.store.put(install('s', { life: 'live', exitCode: undefined, endedAt: undefined }))
      const parent = context.store.get('p') ?? fail()

      const first = JSON.stringify(context.manager.infoOf(parent))
      context.clock.now += 60_000

      expect(JSON.stringify(context.manager.infoOf(parent))).toBe(first)
    })

    it('names the run the starting parent waits on, and the badge that says so', async () => {
      const context = await harness()
      await context.store.put(record('p', { life: 'starting', pendingSetup: { setupSessionId: 's' } }))
      await context.store.put(install('s', { life: 'live', exitCode: undefined, endedAt: undefined }))

      const scripts = context.manager.infoOf(context.store.get('p') ?? fail()).scripts

      expect(scripts?.waitingOn).toBe('s')
      expect(scripts?.badge).toMatchObject({ phase: 'before', state: 'running', text: 'installing dependencies', runId: 's' })
    })

    it('gives the succeeded badge the history entry that holds the log, and the resolver no badge', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('s', { createdAt: 15_000, endedAt: 38_600 }))
      context.runtimes.set('s', dead('s', ['done']))
      await context.manager.settle('s')
      await context.manager.collapse('s')
      await context.store.put(install('r', {
        title: 'Resolve',
        createdAt: 40_000,
        commands: undefined,
        scriptOf: { sessionId: 'p', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
      }))

      const scripts = context.manager.infoOf(context.store.get('p') ?? fail()).scripts

      expect(scripts?.badge).toMatchObject({ phase: 'before', state: 'succeeded', text: 'setup ✓ 23.6 s', runId: 's' })
      expect(scripts?.waitingOn).toBeUndefined()
      expect(scripts?.runs.map((run) => [run.runId, run.log])).toEqual([['r', 'none'], ['s', 'saved']])
      expect(scripts?.runs[0]?.commands).toEqual([])
    })

    // The snapshot reaches every paired peer, and an agent's command may carry a token.
    it('leaves the commands of a requested run out of the snapshot and keeps them for sessions.scripts', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(install('r', {
        life: 'live',
        exitCode: undefined,
        endedAt: undefined,
        commands: [{ command: 'curl -H "Authorization: secret" x', cwd: 'C:\\w' }],
        scriptOf: { sessionId: 'p', phase: 'inner', scriptId: 'requested', name: 'call' },
      }))
      await context.store.put(install('s', { createdAt: 1_000 }))

      const runs = context.manager.infoOf(context.store.get('p') ?? fail()).scripts?.runs ?? []
      expect(runs.map((run) => [run.runId, run.commands])).toEqual([['r', []], ['s', ['pnpm install']]])
      const read = await context.manager.scriptsOf('p')
      expect(read.ok && read.value.runs[0]?.commands).toEqual(['curl -H "Authorization: secret" x'])
    })
  })

  function fail(): never {
    throw new Error('the record is missing')
  }
})
