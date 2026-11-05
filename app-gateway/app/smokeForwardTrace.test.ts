import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ProcessMessage } from '../../lib-orchestrator/shared/processWire.types'
import { SmokeForwardTrace } from './smokeForwardTrace'

test('private file receipt contains correlation only and ignores other private messages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-forward-'))
  try {
    SmokeForwardTrace.sent({ type: 'heartbeat', seq: 1 }, directory)
    SmokeForwardTrace.sent({ type: 'call', id: 1, target: 'other', method: 'execute', args: [] }, directory)
    SmokeForwardTrace.sent({ type: 'call', id: 2, target: 'peer-work', method: 'view', args: [] }, directory)
    assert.deepEqual(readdirSync(directory), [])
    SmokeForwardTrace.sent({ type: 'call', id: 3, target: 'peer-work', method: 'execute', args: [
      { connectionId: 'connection', remoteIdentity: { privateKey: 'NEVER-PRINT' } },
      { requestId: 'request', operation: 'projects.list', body: { token: 'NEVER-PRINT' } },
    ] } satisfies ProcessMessage, directory)
    const text = readFileSync(join(directory, 'latency-forward.jsonl'), 'utf8')
    assert(text.endsWith('\n'))
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 1)
    const value = JSON.parse(lines[0]!)
    assert.deepEqual(Object.keys(value).sort(), ['at', 'connectionId', 'kind', 'operation', 'pid', 'requestId'])
    assert.equal(value.kind, 'forward')
    assert.equal(value.connectionId, 'connection')
    assert.equal(value.requestId, 'request')
    assert.equal(value.operation, 'projects.list')
    assert.equal(value.pid, process.pid)
    assert(Number.isFinite(value.at) && value.at > 0)
    assert(!text.includes('NEVER-PRINT'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
