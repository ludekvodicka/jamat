import { describe, expect, it } from 'vitest'

import type { RuntimeLaunchSpec, RuntimeResult } from '../../../app-host/app/wire/hostWire.js'
import type { HostCallFailure, HostCallResult } from '../../hostClient/hostClient.types'
import type { SessionRecord } from '../records/sessionRecord.types'
import { ScriptRunLauncher } from './scriptRunLauncher'

describe('lib-orchestrator/sessionManager/lifecycle/scriptRunLauncher', () => {
  const run: SessionRecord = {
    sessionId: 'r',
    kind: 'shell',
    title: 'codegen fix',
    directory: { mode: 'adHoc', path: '/w' },
    commands: [{ command: 'pnpm codegen', cwd: '/w' }],
    scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'declared', name: 'codegen', stepKey: 'k' },
    binding: null,
    life: 'starting',
    pendingOperationId: 'op-r',
    pendingOperationKind: 'create',
    createdAt: 1,
  }
  const launchSpec = { command: 'shell', args: [], cwd: '/w', env: {}, cols: 80, rows: 24 } as unknown as RuntimeLaunchSpec
  const created = { session: { runtimeSessionId: 'r', generation: 1 }, hostInstanceId: 'h' } as unknown as RuntimeResult

  function launcher(answer: HostCallResult<RuntimeResult>, problem: string | null = null) {
    const events: string[] = []
    const requests: unknown[] = []
    const subject = new ScriptRunLauncher({
      host: {
        async runtimeCreate(request) {
          requests.push(request)
          return answer
        },
      },
      launch: {
        plannedLaunch: (record, launch) => {
          events.push(`plan ${record.sessionId} ${launch}`)
          return launchSpec
        },
        launchProblem: () => problem,
        bindLive: async (record) => {
          events.push(`bind ${record.sessionId}`)
          return true
        },
        endRefused: async (record, detail) => {
          events.push(`end ${record.sessionId}: ${detail}`)
        },
        markLaunchWait: async (sessionId, reason) => {
          events.push(`wait ${sessionId}: ${reason}`)
        },
      },
    })
    return { subject, events, requests }
  }

  it('creates the run under its own pending pair and binds the answer', async () => {
    const { subject, events, requests } = launcher({ ok: true, value: created })

    expect(await subject.launch(run)).toEqual({ ok: true, value: undefined })
    expect(requests).toEqual([{ operationId: 'op-r', runtimeSessionId: 'r', launch: launchSpec }])
    expect(events).toEqual(['plan r create', 'bind r'])
  })

  it('ends a run the Host refused after judging the request', async () => {
    const refused: HostCallFailure = { ok: false, code: 'op-rejected', status: 400, detail: 'launch.cwd must exist' }
    const { subject, events } = launcher(refused)

    expect(await subject.launch(run)).toEqual({ ok: false, code: 'op-rejected', detail: 'launch.cwd must exist' })
    expect(events).toEqual(['plan r create', 'end r: launch.cwd must exist'])
  })

  // Undecided: the pending pair stays for the reconciler's replay, paced like any other launch.
  it('keeps an undecided run pending and paces its replay', async () => {
    const { subject, events } = launcher({ ok: false, code: 'host-unreachable', detail: 'no descriptor' })

    expect(await subject.launch(run)).toEqual({ ok: false, code: 'host-unreachable', detail: 'no descriptor' })
    expect(events).toEqual(['plan r create', 'wait r: no descriptor'])
  })

  // The Host may run the process although its answer never arrived: the next listing decides.
  it('keeps a run that is not replayable pending on a refusal the Host did not decide', async () => {
    const requested: SessionRecord = {
      ...run,
      scriptOf: { sessionId: 'p', phase: 'inner', scriptId: 'requested', name: 'tests' },
    }
    const full: HostCallFailure = { ok: false, code: 'op-rejected', status: 429, detail: 'too many live runtimes' }
    for (const answer of [full, { ok: false, code: 'host-unreachable', detail: 'no descriptor' } as const]) {
      const { subject, events } = launcher(answer)
      expect(await subject.launch(requested)).toEqual({ ok: false, code: answer.code, detail: answer.detail })
      expect(events).toEqual(['plan r create', `wait r: ${answer.detail}`])
    }
    const { subject, events } = launcher({ ok: false, code: 'op-rejected', status: 400, detail: 'bad cwd' })
    await subject.launch(requested)
    expect(events).toEqual(['plan r create', 'end r: bad cwd'])
  })

  // Never a shell that might find another program, and never a replay of a tool that stays missing.
  it('ends a direct-process run whose tool is missing, without planning or asking the Host', async () => {
    const tool: SessionRecord = { ...run, commands: undefined, process: { tool: 'svn', args: ['update'] } }
    const { subject, events, requests } = launcher({ ok: true, value: created }, 'svn.exe was not found on PATH')

    expect(await subject.launch(tool)).toEqual({ ok: false, code: 'spawn-failed', detail: 'svn.exe was not found on PATH' })
    expect(requests).toEqual([])
    expect(events).toEqual(['end r: svn.exe was not found on PATH'])
  })

  it('throws on a run that names no launch', async () => {
    const { subject } = launcher({ ok: true, value: created })
    await expect(subject.launch({ ...run, pendingOperationId: undefined })).rejects.toThrow('Script run r names no launch')
  })
})
