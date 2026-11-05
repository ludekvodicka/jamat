import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PerfNames } from './perfNames'
import { PerfReportView } from './perfReportView'
import type { PerfEvent, PerfRecord } from './perfRecord.types'

const at = Date.UTC(2026, 10, 2)
const record = (event: PerfEvent, time = at): PerfRecord => ({ ...event, v: 1, at: time, process: 'main', pid: 1,
  build: { version: '3.10.0', inputHash: 'a'.repeat(64), builtAt: new Date(at).toISOString() } })
const sample: PerfEvent = { kind: 'sample', elu: 0.1, loopP50: null, loopP99: null, loopMax: null, heapMb: 10 }

describe('offline performance report', () => {
  it('accepts unavailable own CPU and bounded custom display numbers while retaining old numeric records', () => {
    for (const jamatCpu of [null, 0, 0.2])
      expect(PerfNames.readRecord(record({ kind: 'machine', cpu: 0.8, jamatCpu }))).not.toBeNull()
    for (const session of ['093', 'i34', '014-015'])
      expect(PerfNames.readRecord(record({ kind: 'runaway', image: 'node.exe', cores: 0.9, minutes: 10, session, sessionKind: 'agent' }))).not.toBeNull()
    expect(PerfNames.readRecord(record({ kind: 'runaway', image: 'node.exe', cores: 0.9, minutes: 10, session: 'Private title', sessionKind: 'agent' }))).toBeNull()
  })

  it('excludes a suspended interval starting before selection and sixty seconds after resume', () => {
    const result = PerfReportView.summarize([
      record({ kind: 'suspend' }, at - 3_600_000), record(sample),
      record({ kind: 'resume' }, at + 60_000), record(sample, at + 90_000), record(sample, at + 120_000),
    ], at, at + 180_000)
    expect(result.activeHours).toEqual({ main: 1 / 60 })
    expect(result.excludedWindows).toEqual([
      { from: at - 3_600_000, to: at + 60_000, reason: 'suspend' },
      { from: at + 60_000, to: at + 120_000, reason: 'resume' },
    ])
  })
  it('parses the Host schema fixture alongside client records from another directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'perf-host-report-'))
    const host = { v: 1, at: at + 200, process: 'host', pid: 123,
      build: { version: '0.1.2', inputHash: 'b'.repeat(64), builtAt: '2026-11-02T00:00:00.000Z' },
      kind: 'stall', ms: 150, covered: [] }
    try {
      await writeFile(join(directory, 'host-2026-11-02.jsonl'), JSON.stringify(host) + '\n')
      const report = await PerfReportView.read([join(directory, 'missing-client'), directory, directory], at, at + 60_000)
      expect(report.stalls).toEqual([host])
      expect(report.corruptLines).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('retains renderer input percentiles and samples in their measured minute', () => {
    const input = { ...record({ kind: 'inputToFrame', p50: 30, p99: 90, count: 10 }), process: 'renderer' as const }
    const measured = { ...record(sample), process: 'renderer' as const }
    const report = PerfReportView.summarize([input, measured], at, at + 60_000)
    expect(report.inputToFrame).toEqual([input])
    expect(report.samples).toEqual([measured])
  })
  it('sums exclusive blocking time and counts only unique sampled minutes', () => {
    const result = PerfReportView.summarize([
      record(sample), record(sample, at + 100), record(sample, at + 3_600_000),
      record({ kind: 'span', name: 'sessions.recompose', ms: 100, selfMs: 40, depth: 0, blocking: true }),
      record({ kind: 'span', name: 'records.commit', ms: 60, selfMs: 60, depth: 1, blocking: true }),
      record({ kind: 'span', name: 'finish.commit', ms: 10_000, selfMs: 10_000, depth: 0, blocking: false }),
    ], at, at + 7_200_000)
    expect(result.activeHours).toEqual({ main: 2 / 60 })
    expect(result.top.map(row => [row.name, row.selfMs, row.selfMsPerActiveHour]))
      .toEqual([['records.commit', 60, 1800], ['sessions.recompose', 40, 1200]])
    expect(result.top.reduce((sum, row) => sum + row.selfMs, 0)).toBe(100)
    expect(result.operations).toEqual([{ process: 'main', name: 'finish.commit', ms: 10_000, count: 1 }])
  })

  it('excludes resume windows including a resume preceding the selected interval', () => {
    const result = PerfReportView.summarize([
      record({ kind: 'resume' }, at - 10_000),
      record(sample), record(sample, at + 60_000),
      record({ kind: 'stall', ms: 2_000, covered: [] }),
      record({ kind: 'stall', ms: 300, covered: [] }, at + 60_000),
    ], at, at + 120_000)
    expect(result.stalls.map(stall => stall.ms)).toEqual([300])
    expect(result.activeHours).toEqual({ main: 1 / 60 })
    expect(result.excludedWindows).toEqual([{ from: at - 10_000, to: at + 50_000, reason: 'resume' }])
  })

  it('reads persisted registered names without a running registry, skips corrupt and incomplete lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'perf-report-'))
    const names = new PerfNames(['sessions:list'], ['sessions.list'])
    const ipc = record({ kind: 'span', name: 'ipc:sessions:list', ms: 100, selfMs: 100, depth: 0, blocking: true })
    const op = record({ kind: 'span', name: 'op:sessions.list', ms: 200, selfMs: 200, depth: 0, blocking: true })
    try {
      expect(names.record(ipc)).toEqual(ipc)
      expect(names.record(op)).toEqual(op)
      expect(new PerfNames().record(ipc)).toBeNull()
      await writeFile(join(directory, 'main-2026-11-02.jsonl'),
        [record(sample), ipc, op].map(row => JSON.stringify(row)).join('\n') + '\ninvalid\n{"kind":')
      await writeFile(join(directory, 'main-2026-10-20.jsonl'), 'invalid old line\n')
      const report = await PerfReportView.read(directory, at, at + 60_000)
      expect(report.top.map(row => row.name)).toEqual(['op:sessions.list', 'ipc:sessions:list'])
      expect(report.corruptLines).toBe(2)
      expect(PerfNames.readRecord({ ...ipc, name: 'ipc:C:/secret' })).toBeNull()
      expect(await PerfReportView.read(join(directory, 'missing'), at, at + 60_000))
        .toMatchObject({ top: [], activeHours: {}, corruptLines: 0 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
