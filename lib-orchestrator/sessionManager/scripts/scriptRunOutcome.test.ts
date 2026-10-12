import { describe, expect, it } from 'vitest'

import type { RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import type { SessionRecord } from '../records/sessionRecord.types'
import { ScriptRunOutcome } from './scriptRunOutcome'

describe('lib-orchestrator/sessionManager/scripts/scriptRunOutcome', () => {
  const words = { session: 'setup', actor: 'setup' }

  function run(overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 's',
      kind: 'shell',
      title: 's',
      directory: { mode: 'default' },
      binding: null,
      life: 'starting',
      createdAt: 1,
      pendingOperationId: 'op-s',
      pendingOperationKind: 'create',
      scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'setup', name: 'setup' },
      ...overrides,
    }
  }

  function runtime(overrides?: Partial<RuntimeSessionInfo>): RuntimeSessionInfo {
    return {
      runtimeSessionId: 's',
      generation: 1,
      alive: true,
      cols: 120,
      rows: 30,
      outputSeq: 0,
      outputEpoch: 1,
      lastOutputAt: null,
      startedAt: 1_000,
      ...overrides,
    }
  }

  function judge(records: SessionRecord[], sessions: RuntimeSessionInfo[] = []) {
    return ScriptRunOutcome.judge('s', records, new Map(sessions.map((entry) => [entry.runtimeSessionId, entry])), words)
  }

  it('waits while the runtime runs, or while the run replays its own launch', () => {
    expect(judge([run({ life: 'live' })], [runtime()])).toEqual({ kind: 'running' })
    expect(judge([run()])).toEqual({ kind: 'running' })
  })

  it('reads exit 0 as a success, from the runtime and from an ended record alike', () => {
    const succeeded = { kind: 'succeeded', outcome: 'succeeded', exitCode: 0 }
    expect(judge([run({ life: 'live' })], [runtime({ alive: false, exitCode: 0 })])).toEqual(succeeded)
    expect(judge([run({ life: 'ended', exitCode: 0 })])).toEqual(succeeded)
  })

  it('reads any other exit as a failure that keeps the code', () => {
    expect(judge([run({ life: 'live' })], [runtime({ alive: false, exitCode: 1 })]))
      .toEqual({ kind: 'failed', outcome: 'failed', reason: 'the setup exited with 1', exitCode: 1 })
    expect(judge([run({ life: 'live' })], [runtime({ alive: false })]))
      .toEqual({ kind: 'failed', outcome: 'failed', reason: 'the setup exited with no exit code' })
    expect(judge([run({ life: 'ended', exitCode: 3 })]))
      .toEqual({ kind: 'failed', outcome: 'failed', reason: 'the setup ended with 3', exitCode: 3 })
  })

  it('quotes the Host when it refused to launch the run', () => {
    expect(judge([run({ life: 'ended', endedReason: 'launch.cwd must be an existing directory' })])).toEqual({
      kind: 'failed',
      outcome: 'failed',
      reason: 'the setup could not start: launch.cwd must be an existing directory',
    })
    expect(ScriptRunOutcome.judge('s', [run({ life: 'ended', endedReason: 'refused' })], new Map(), { session: 'codegen', actor: 'codegen script' }))
      .toMatchObject({ reason: 'the codegen script could not start: refused' })
    expect(judge([run({ life: 'ended' })]))
      .toEqual({ kind: 'failed', outcome: 'failed', reason: 'the setup ended with no exit code' })
    expect(judge([run({ life: 'ended', exitCode: 2, endedReason: 'ignored' })]))
      .toMatchObject({ reason: 'the setup ended with 2', exitCode: 2 })
  })

  // On POSIX a signalled process reports 0; the stop is asked first so it can never read as clean.
  it('reads a stopped run as stopped before it reads the exit code', () => {
    expect(judge([run({ life: 'live', stopRequested: true })], [runtime({ alive: false, exitCode: 0 })]))
      .toEqual({ kind: 'failed', outcome: 'stopped', reason: 'its setup was stopped' })
    expect(judge([run({ life: 'ended', exitCode: 0, stopRequested: true })]))
      .toEqual({ kind: 'failed', outcome: 'stopped', reason: 'its setup was stopped' })
  })

  it('reads a run nothing can finish any more as lost', () => {
    expect(judge([])).toEqual({ kind: 'failed', outcome: 'lost', reason: 'its setup session record is gone' })
    expect(judge([run({ pendingOperationId: undefined, pendingOperationKind: undefined })]))
      .toEqual({ kind: 'failed', outcome: 'lost', reason: 'its setup session names no launch to replay' })
    expect(judge([run({ pendingOperationKind: undefined })]))
      .toEqual({ kind: 'failed', outcome: 'lost', reason: 'its setup session names no launch to replay' })
    expect(judge([run({ life: 'live' })]))
      .toEqual({ kind: 'failed', outcome: 'lost', reason: 'its setup session is not on the Host any more' })
    expect(judge([run({ life: 'lost' })]))
      .toEqual({ kind: 'failed', outcome: 'lost', reason: 'its setup session was lost' })
  })

  it('names the run with the nouns it was handed', () => {
    const resolver = { session: 'resolve', actor: 'resolver' }
    expect(ScriptRunOutcome.judge('r', [], new Map(), resolver))
      .toEqual({ kind: 'failed', outcome: 'lost', reason: 'its resolve session record is gone' })
    expect(ScriptRunOutcome.judge('s', [run({ life: 'ended', exitCode: 1 })], new Map(), resolver))
      .toEqual({ kind: 'failed', outcome: 'failed', reason: 'the resolver ended with 1', exitCode: 1 })
  })
})
