import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LatencyMeasurement, type LatencyBoundary } from './latencyMeasurement'

const marker = `M-${'a'.repeat(32)}`
const start: LatencyBoundary = { kind: 'block', phase: 'start', id: 'b', process: 'orchestrator', target: 'orchestrator',
  pid: 1, milliseconds: 3000, at: 1000, observedAt: 1002 }
const end: LatencyBoundary = { ...start, phase: 'end', at: 4000, observedAt: 4002 }
const sample = { marker, startedAt: 1100, arrivedAt: 1130, milliseconds: 30 }

test('neither Windows nor POSIX command echo can contain the final marker', () => {
  for (const platform of ['win32', 'linux'] as const)
    assert(!LatencyMeasurement.command(marker, platform).includes(marker))
})

test('accepts only an externally confirmed marker inside a full block, below the exact limit', () => {
  LatencyMeasurement.check(sample, start, end)
  for (const invalid of [
    { ...sample, startedAt: 1001, arrivedAt: 1031, milliseconds: 30 },
    { ...sample, startedAt: 3990, arrivedAt: 4010, milliseconds: 20 },
    { ...sample, arrivedAt: 1099, milliseconds: -1 },
  ]) assert.throws(() => LatencyMeasurement.check(invalid, start, end))
  assert.throws(() => LatencyMeasurement.check(sample, start, { ...end, at: 3999 }))
  assert.throws(() => LatencyMeasurement.check(sample, start, { ...end, id: 'other' }))
  assert.throws(() => LatencyMeasurement.check(sample, start))
  assert.throws(() => LatencyMeasurement.check({ ...sample, arrivedAt: 1400, milliseconds: 0 }, start, end))
  assert.throws(() => LatencyMeasurement.check({ ...sample, arrivedAt: 1300, milliseconds: 200 }, start, end))
})

test('rejects mismatched actual process, target and duration in the block receipts', () => {
  assert.throws(() => LatencyMeasurement.check(sample, { ...start, process: 'main' }, end))
  assert.throws(() => LatencyMeasurement.check(sample, start, { ...end, process: 'main' }))
  assert.throws(() => LatencyMeasurement.check(sample, start, { ...end, target: 'main' }))
  assert.throws(() => LatencyMeasurement.check(sample, start, { ...end, milliseconds: 20000 }))
})

test('CLI status includes all external elapsed time, stays below 500 ms and completes while main is blocked', () => {
  const mainStart = { ...start, process: 'main' as const, target: 'main' as const }
  const mainEnd = { ...end, process: 'main' as const, target: 'main' as const }
  const status = { operation: 'system.status' as const, startedAt: 1100, arrivedAt: 1599, milliseconds: 499 }
  LatencyMeasurement.checkStatus(status, mainStart, mainEnd)
  assert.throws(() => LatencyMeasurement.checkStatus({ ...status, arrivedAt: 1600, milliseconds: 500 }, mainStart, mainEnd))
  assert.throws(() => LatencyMeasurement.checkStatus({ ...status, milliseconds: 100 }, mainStart, mainEnd))
  assert.throws(() => LatencyMeasurement.checkStatus({ ...status, startedAt: 1001, arrivedAt: 1100, milliseconds: 99 }, mainStart, mainEnd))
  assert.throws(() => LatencyMeasurement.checkStatus({ ...status, startedAt: 3999, arrivedAt: 4001, milliseconds: 2 }, mainStart, mainEnd))
  assert.throws(() => LatencyMeasurement.checkStatus(status, start, end))
})
