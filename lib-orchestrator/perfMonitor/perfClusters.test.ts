import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PerfBuild, PerfEvent, PerfRecord } from './perfRecord.types'
import { PerfReportView, type PerfClusterOptions } from './perfReportView'

const at = Date.UTC(2026, 10, 2, 12)
const build = { version: '3.10.0', inputHash: 'a'.repeat(64), builtAt: new Date(at - 3_600_000).toISOString() }
const row = (event: PerfEvent, time = at, identity: PerfBuild = build): PerfRecord =>
  ({ ...event, at: time, build: identity, v: 1, pid: 1, process: 'main' })
const sample: PerfEvent = { kind: 'sample', elu: 0.2, loopP50: null, loopP99: null, loopMax: null, heapMb: null }
const span: PerfEvent = { kind: 'span', name: 'records.commit', ms: 100, selfMs: 40, depth: 0, blocking: true }
const options: PerfClusterOptions = { since: at - 120_000, until: at + 120_000, runningBuilds: { main: build },
  hostProcess: null, selfMsPerActiveHour: 1_000, maxSpanMs: 2_000 }
let root: string
async function write(records: PerfRecord[], cover = true) {
  const files = new Map<string, PerfRecord[]>([['machine-2026-11-02.jsonl', []]])
  if (cover) records = [...records, ...[-60_000, 0, 60_000, 120_000].map(offset =>
    ({ ...row({ kind: 'machine', cpu: 0.2, jamatCpu: null }, at + offset), process: 'machine' as const }))]
  for (const record of records) {
    const name = `${record.process.replace(':', '-')}-2026-11-02.jsonl`
    files.set(name, [...files.get(name) ?? [], record])
  }
  await Promise.all([...files].map(([name, rows]) => writeFile(join(root, name), rows.map(value => JSON.stringify(value)).join('\n') + '\n')))
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'perf-clusters-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('streamed performance clusters', () => {
  it('defers unmeasured intervals and never admits an external stall before its CPU observation arrives', async () => {
    const machine = (time: number, cpu: number) => ({ ...row({ kind: 'machine', cpu, jamatCpu: null }, time), process: 'machine' as const })
    const fresh = row({ ...span, ms: 2_000, selfMs: 2_000 }, at + 30_000)
    const history = [machine(at, 0.2), row(sample, at + 30_000), fresh]
    const later = { ...options, until: at + 180_000 }
    await write(history, false)
    expect(await PerfReportView.clusters(root, later)).toEqual([])
    history.push(machine(at + 60_000, 0.8))
    await write(history, false)
    expect(await PerfReportView.clusters(root, later)).toEqual([])
    history.push(machine(at + 180_000, 0.2), row(sample, at + 150_000), { ...fresh, at: at + 150_000 })
    await write(history, false)
    expect(await PerfReportView.clusters(root, later)).toMatchObject([{ count: 1, activeHours: 1 / 60, selfMs: 2_000 }])
  })
  it('uses exclusive time, per-build sampled minutes and the latest matching profile', async () => {
    const newer = { ...build, inputHash: 'b'.repeat(64), builtAt: new Date(at).toISOString() }
    await write([row(sample), row(sample, at + 1), row(span), row(sample, at + 60_000, newer), row(span, at + 60_000, newer),
      row({ kind: 'profile', profileId: 'measured.cpuprofile', trigger: 'elu' }),
      row({ ...span, blocking: false, ms: 10_000, selfMs: 10_000 }),
      row({ kind: 'stall', ms: 100, covered: ['records.commit'] })])
    const clusters = await PerfReportView.clusters(root, options)
    expect(clusters).toHaveLength(2)
    expect(clusters.map(value => [value.selfMs, value.activeHours, value.selfMsPerActiveHour])).toEqual([[40, 1 / 60, 2400], [40, 1 / 60, 2400]])
    expect(clusters.find(value => value.build.inputHash === build.inputHash)?.profileId).toBe('measured.cpuprofile')
    expect(await PerfReportView.clusters(root, { ...options, selfMsPerActiveHour: 3_000 })).toEqual([])
  })

  it('compares build order only for different hashes and retains an identical-hash rebuild', async () => {
    const old = { ...build, inputHash: 'b'.repeat(64), builtAt: new Date(at - 7_200_000).toISOString() }
    await write([row(sample), row(span), row(sample, at + 60_000, old), row(span, at + 60_000, old)])
    const rebuilt = { ...build, builtAt: new Date(at + 60_000).toISOString() }
    expect((await PerfReportView.clusters(root, { ...options, runningBuilds: { main: rebuilt } })).map(value => value.build.inputHash))
      .toEqual([build.inputHash])
  })

  it('excludes external load using own CPU and overlaps the entire measured interval at boundaries', async () => {
    const machine = (jamatCpu: number | null) => ({ ...row({ kind: 'machine', cpu: 0.8, jamatCpu }), process: 'machine' as const })
    const crossing = row({ ...span, ms: 2_000, selfMs: 2_000 }, at + 1_000)
    for (const jamatCpu of [0, null]) {
      await write([row(sample, at - 30_000), crossing, machine(jamatCpu)])
      expect(await PerfReportView.clusters(root, options)).toEqual([])
    }
    await write([row(sample, at - 30_000), crossing, machine(0.4)])
    expect(await PerfReportView.clusters(root, options)).toHaveLength(1)
  })

  it('excludes suspend and resume overlap while preserving unavailable rates on later long stalls', async () => {
    await write([
      { ...row({ kind: 'suspend' }, at - 60_000), process: 'machine' },
      { ...row({ kind: 'resume' }), process: 'machine' },
      row({ kind: 'stall', ms: 2_000, covered: [] }, at + 61_000),
      row({ kind: 'stall', ms: 2_000, covered: [] }, at + 90_000),
    ])
    expect(await PerfReportView.clusters(root, options)).toMatchObject([
      { name: 'unattributed', count: 1, maxMs: 2_000, selfMsPerActiveHour: null },
    ])
  })

  it('identifies a surviving Host from its own pid/start records and waits when that evidence is absent', async () => {
    const hostBuild = { ...build, inputHash: 'c'.repeat(64), builtAt: new Date(at - 86_400_000).toISOString() }
    const host = (event: PerfEvent, time = at) => ({ ...row(event, time, hostBuild), process: 'host' as const, pid: 44 })
    await write([host(sample), host(span), { ...host(sample), pid: 55, build }])
    expect(await PerfReportView.clusters(root, { ...options, hostProcess: { pid: 44, startedAt: at - 1_000 } }))
      .toMatchObject([{ process: 'host', build: hostBuild }])
    expect(await PerfReportView.clusters(root, { ...options, hostProcess: { pid: 44, startedAt: at + 1 } })).toEqual([])
    expect(await PerfReportView.clusters(root, options)).toEqual([])
  })

  it('fails closed at the bounded cluster capacity rather than retaining an unbounded history', async () => {
    await write(Array.from({ length: 4_097 }, (_, index) => row({ ...span, name: `op:fixture${index}` })))
    await expect(PerfReportView.clusters(root, options)).rejects.toThrow('bounded capacity')
  })
})
