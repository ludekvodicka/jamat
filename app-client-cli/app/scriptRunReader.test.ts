import { describe, expect, it } from 'vitest'

import type {
  RemoteControlErrorCode,
  RemoteControlResponse,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { SessionScriptRunInfo } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ScriptRunReader } from './scriptRunReader'

type RunStep = Pick<SessionScriptRunInfo, 'state' | 'log'> & { exitCode?: number }

class ScriptRunFixture {
  time = 0
  reads = 0
  steps: RunStep[] = [
    { state: 'running', log: 'none' },
    { state: 'succeeded', log: 'none', exitCode: 0 },
    { state: 'succeeded', log: 'saved', exitCode: 0 },
  ]

  static run(step: RunStep): SessionScriptRunInfo {
    return {
      runId: 'run-1',
      phase: 'inner',
      scriptId: 'requested',
      name: 'tests',
      title: 'tests',
      summary: `tests · ${step.state}`,
      startedAt: 1,
      commands: ['pnpm test'],
      row: step.state !== 'succeeded',
      ...step,
    }
  }

  answer(step: RunStep): RemoteControlResponse {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: 'read',
      operation: 'sessions.scripts',
      operationId: null,
      ok: true,
      value: {
        sessionId: 'parent-1',
        logContentUntrusted: true,
        runs: [ScriptRunFixture.run(step)],
        log: step.log === 'saved' ? { runId: 'run-1', text: 'untrusted output\n', truncated: false } : null,
        ...(step.log === 'unavailable' ? { logDetail: 'the Host restarted before the output was saved' } : {}),
      },
    }
  }

  /** Reads that fail before the steps are answered: a rejection, or a refusal with this code. */
  failures: (Error | RemoteControlErrorCode)[] = []

  static refused(code: RemoteControlErrorCode): RemoteControlResponse {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: null,
      operation: 'sessions.scripts',
      operationId: null,
      ok: false,
      error: { code, detail: `refused with ${code}` },
    }
  }

  reader(): ScriptRunReader {
    return new ScriptRunReader({
      read: async () => {
        const failure = this.failures.shift()
        if (failure instanceof Error) throw failure
        if (failure !== undefined) return ScriptRunFixture.refused(failure)
        return this.answer(this.steps[Math.min(this.reads++, this.steps.length - 1)]!)
      },
      now: () => this.time,
      pause: async (milliseconds) => { this.time += milliseconds },
    })
  }
}

describe('app-client-cli/app/scriptRunReader', () => {
  it('waits until a run succeeded and its log was saved, then answers its log', async () => {
    const f = new ScriptRunFixture()
    expect(await f.reader().read('run-1', 10_000)).toEqual({
      ok: true,
      value: {
        sessionId: 'parent-1',
        runId: 'run-1',
        state: 'succeeded',
        exitCode: 0,
        logContentUntrusted: true,
        log: { text: 'untrusted output\n', truncated: false },
      },
    })
    expect(f.reads).toBe(3)
    expect(f.time).toBe(2_000)
  })

  it('answers a run that did not succeed as operation-failed with the run and its log', async () => {
    for (const state of ['failed', 'stopped', 'lost'] as const) {
      const f = new ScriptRunFixture()
      f.steps = [{ state: 'running', log: 'none' }, { state, log: 'saved', exitCode: 2 }]
      expect(await f.reader().read('run-1', 10_000)).toEqual({
        ok: false,
        error: {
          code: 'operation-failed',
          detail: `Script run run-1 did not succeed: tests · ${state}`,
          data: {
            run: ScriptRunFixture.run({ state, log: 'saved', exitCode: 2 }),
            logContentUntrusted: true,
            log: { text: 'untrusted output\n', truncated: false },
          },
        },
      })
    }
  })

  it('carries why a settled run has no log', async () => {
    const f = new ScriptRunFixture()
    f.steps = [{ state: 'lost', log: 'unavailable' }]
    expect(await f.reader().read('run-1', 10_000)).toMatchObject({
      ok: false,
      error: { data: { log: null, logDetail: 'the Host restarted before the output was saved' } },
    })
  })

  it('times out on a run still running, and stops when aborted', async () => {
    const f = new ScriptRunFixture()
    f.steps = [{ state: 'running', log: 'none' }]
    await expect(f.reader().read('run-1', 2_500)).rejects.toMatchObject({
      code: 'timeout',
      message: 'Script run run-1 is still running; read it with sessions scripts --run-id run-1',
    })
    expect(f.time).toBe(2_500)
    const abort = new AbortController()
    abort.abort()
    await expect(f.reader().read('run-1', 10_000, abort.signal)).rejects.toMatchObject({ code: 'operation-failed' })
  })

  it('reads again after a read that failed on the way, with a short backoff', async () => {
    const f = new ScriptRunFixture()
    f.failures = [new Error('read ECONNRESET'), 'unavailable', 'timeout', 'conflict', 'operation-failed']

    expect(await f.reader().read('run-1', 10_000)).toMatchObject({ ok: true, value: { state: 'succeeded' } })
    expect(f.failures).toEqual([])
    expect(f.time).toBe(250 + 500 + 1_000 + 2_000 + 4_000 + 2_000)
  })

  it('stops at once on a refusal that cannot change', async () => {
    for (const code of ['not-found', 'invalid-request', 'forbidden', 'protocol-mismatch'] as const) {
      const f = new ScriptRunFixture()
      f.failures = [code]
      expect(await f.reader().read('run-1', 10_000)).toMatchObject({ ok: false, error: { code, data: { runId: 'run-1' } } })
      expect(f.time).toBe(0)
    }
  })

  it('answers the last failure when the reads keep failing until the deadline', async () => {
    const refused = new ScriptRunFixture()
    refused.failures = Array.from({ length: 20 }, () => 'unavailable' as const)
    expect(await refused.reader().read('run-1', 3_000)).toEqual({
      ok: false,
      error: { code: 'unavailable', detail: 'Script run run-1: refused with unavailable', data: { runId: 'run-1' } },
    })
    expect(refused.time).toBe(3_000)

    const rejected = new ScriptRunFixture()
    rejected.failures = Array.from({ length: 20 }, () => new Error('read ECONNRESET'))
    await expect(rejected.reader().read('run-1', 3_000)).rejects.toMatchObject({
      code: 'operation-failed',
      message: 'Cannot read script run run-1; its outcome is unknown: read ECONNRESET',
    })
    expect(rejected.time).toBe(3_000)
  })

  it('returns a refusal of the read with the run id, and refuses an answer without the run', async () => {
    const refused: RemoteControlResponse = {
      protocol: RemoteControlConst.protocol,
      requestId: null,
      operation: 'sessions.scripts',
      operationId: null,
      ok: false,
      error: { code: 'not-found', detail: 'No session parent-1' },
    }
    const reader = new ScriptRunReader({
      read: async () => refused,
      now: () => 0,
      pause: async () => { throw new Error('Unexpected wait') },
    })
    expect(await reader.read('run-1', 10)).toEqual({
      ok: false,
      error: { code: 'not-found', detail: 'Script run run-1: No session parent-1', data: { runId: 'run-1' } },
    })
    const f = new ScriptRunFixture()
    await expect(f.reader().read('another', 10)).rejects.toThrow('Invalid answer for script run another')
  })
})
