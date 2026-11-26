import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlOperation, RemoteControlResponse } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlAudit } from './remoteControlAudit'

describe('app-orchestrator/app/remoteControl/remoteControlAudit', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function okResponse(operation: RemoteControlOperation): RemoteControlResponse {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: 'req-1',
      operation,
      operationId: null,
      ok: true,
      value: {},
    }
  }

  it('skips high-frequency local read-only polling ops while auditing mutations and remote callers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamat-audit-'))
    roots.push(dir)
    const file = join(dir, 'audit.jsonl')
    const audit = new RemoteControlAudit(file, vi.fn(), () => 1_000)

    const localCaller = { callerId: 'cli', callerKind: 'local-cli' as const }
    const remoteCaller = { callerId: 'peer', callerKind: 'remote-peer' as const }

    const skippedOps: RemoteControlOperation[] = ['tabs.commitStatus', 'tabs.list', 'system.hello', 'sessions.list']
    for (const op of skippedOps)
      audit.http({ operation: op }, okResponse(op), localCaller)
    audit.flush()
    expect(existsSync(file)).toBe(false)

    // Local mutation is audited.
    audit.http({ operation: 'sessions.create' }, okResponse('sessions.create'), localCaller)
    // Remote read-only polling op is still audited.
    audit.remoteHttp({ operation: 'sessions.list' }, okResponse('sessions.list'), remoteCaller, 'ep-1')
    audit.peerControl({ operation: 'tabs.commitStatus' }, okResponse('tabs.commitStatus'), remoteCaller)
    audit.flush()

    const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.map((row) => `${row.transport}:${row.operation}`)).toEqual([
      'http:sessions.create',
      'http-remote:sessions.list',
      'peer-control:tabs.commitStatus',
    ])
  })

  it('flushes routine batches asynchronously after the coalescing delay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamat-audit-async-'))
    roots.push(dir)
    const file = join(dir, 'audit.jsonl')
    const errors = vi.fn()
    const audit = new RemoteControlAudit(file, errors, () => 2_000)

    audit.http({ operation: 'sessions.create' }, okResponse('sessions.create'), { callerId: 'cli', callerKind: 'local-cli' })
    expect(existsSync(file)).toBe(false)

    await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 2_000 })
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.operation).toBe('sessions.create')
    expect(errors).not.toHaveBeenCalled()
  })
})
