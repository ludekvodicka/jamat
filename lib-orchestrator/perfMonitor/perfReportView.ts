import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PerfNames } from './perfNames'
import type { PerfBuild, PerfName, PerfProcess, PerfRecord } from './perfRecord.types'

export interface PerfStallCluster {
  process: PerfProcess
  name: PerfName
  build: PerfBuild
  selfMs: number
  count: number
  maxMs: number
  activeHours: number
  selfMsPerActiveHour: number | null
  profileId: string | null
}
export interface PerfClusterOptions {
  since: number
  until: number
  runningBuilds: Partial<Record<Exclude<PerfProcess, 'host' | 'machine'>, PerfBuild>>
  hostProcess: { pid: number; startedAt: number } | null
  selfMsPerActiveHour: number
  maxSpanMs: number
}

export interface PerfReport {
  samples: Extract<PerfRecord, { kind: 'sample' }>[]
  inputToFrame: Extract<PerfRecord, { kind: 'inputToFrame' }>[]
  activeHours: Partial<Record<PerfProcess, number>>
  top: { process: PerfProcess; name: PerfName; selfMs: number; selfMsPerActiveHour: number | null; count: number }[]
  operations: { process: PerfProcess; name: PerfName; ms: number; count: number }[]
  stalls: Extract<PerfRecord, { kind: 'stall' }>[]
  external: Extract<PerfRecord, { kind: 'external' }>[]
  runaway: Extract<PerfRecord, { kind: 'runaway' }>[]
  profiles: Extract<PerfRecord, { kind: 'profile' }>[]
  machine: Extract<PerfRecord, { kind: 'machine' }>[]
  excludedWindows: { from: number; to: number; reason: 'resume' | 'suspend' }[]
  corruptLines: number
}

export class PerfReportView {
  static async read(directory: string | readonly string[], since: number, until = Date.now()): Promise<PerfReport> {
    const records: PerfRecord[] = []
    let corruptLines = 0
    for await (const record of PerfReportView.records(directory, since, until, () => { corruptLines++ })) records.push(record)
    return PerfReportView.summarize(records, since, until, corruptLines)
  }

  static async *records(directory: string | readonly string[], since: number, until: number,
    corrupt: () => void = () => {}, processes?: readonly PerfProcess[]): AsyncGenerator<PerfRecord> {
    for (const root of typeof directory === 'string' ? [directory] : [...new Set(directory)]) {
      let files: string[]
      try { files = await readdir(root) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = []
        else throw error
      }
      const firstDate = new Date(Math.max(0, since - 60_000)).toISOString().slice(0, 10)
      const lastDate = new Date(until).toISOString().slice(0, 10)
      for (const file of files.sort()) {
        if (!/^(?:main|gateway|orchestrator|renderer|host|machine|worker-[A-Za-z]+)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue
        if (processes && !processes.some(process => file.startsWith(`${process.replace(':', '-')}-`))) continue
        const date = file.slice(-16, -6)
        const earliest = file.startsWith('machine-')
          ? new Date(Math.max(0, since - 7 * 86_400_000)).toISOString().slice(0, 10) : firstDate
        if (date < earliest || date > lastDate) continue
        const stream = createReadStream(join(root, file), { encoding: 'utf8' })
        const lines = createInterface({ input: stream, crlfDelay: Infinity })
        try {
          for await (const line of lines) {
            if (!line.trim()) continue
            let record: PerfRecord | null = null
            try { record = PerfNames.readRecord(JSON.parse(line)) } catch { /* A writer may still be appending the last line. */ }
            if (record === null) corrupt()
            else if (record.at <= until && (record.at >= since - 60_000 || record.kind === 'suspend' || record.kind === 'resume')) yield record
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        } finally { lines.close(); stream.destroy() }
      }
    }
  }

  static async clusters(directory: string | readonly string[], options: PerfClusterOptions): Promise<PerfStallCluster[]> {
    const { since, until } = options
    const builds: Partial<Record<PerfProcess, PerfBuild>> = { ...options.runningBuilds }
    const power: Pick<PerfRecord, 'kind' | 'at'>[] = []
    const windows: { from: number; to: number }[] = []
    const observations: { from: number; to: number }[] = []
    let hostAt = -1
    for await (const record of PerfReportView.records(directory, since, until, undefined, ['machine', 'host'])) {
      if (record.process === 'host' && options.hostProcess && record.pid === options.hostProcess.pid
        && record.at >= options.hostProcess.startedAt && record.at >= hostAt) {
        hostAt = record.at
        builds.host = record.build
      }
      if (record.kind === 'suspend' || record.kind === 'resume') power.push({ kind: record.kind, at: record.at })
      if (record.kind === 'machine') {
        observations.push({ from: record.at - 60_000, to: record.at + 1 })
        if (record.cpu - (record.jamatCpu ?? 0) >= 0.7) windows.push({ from: record.at - 60_000, to: record.at + 1 })
      }
      if (power.length + windows.length + observations.length > 30_000) throw new Error('Performance exclusion history exceeds its bounded capacity')
    }
    windows.push(...PerfReportView.sleepWindows(power, since, until))
    const merged = PerfReportView.mergeWindows(windows)
    const coverage = PerfReportView.mergeWindows(observations)
    const excluded = (from: number, to: number): boolean => (PerfReportView.windowAfter(merged, from)?.from ?? Infinity) <= to
    const measured = (from: number, to: number): boolean => {
      const window = PerfReportView.windowAfter(coverage, from)
      return window !== undefined && window.from <= from && window.to > to
    }
    const minutes = new Map<string, Set<number>>()
    const profiles = new Map<string, { at: number; id: string }>()
    const clusters = new Map<string, PerfStallCluster>()
    for await (const record of PerfReportView.records(directory, since, until)) {
      if (record.at < since) continue
      const current = builds[record.process]
      if (!current || record.build.inputHash !== current.inputHash && Date.parse(record.build.builtAt) < Date.parse(current.builtAt)) continue
      const buildKey = `${record.process}:${record.build.inputHash}`
      switch (record.kind) {
        case 'sample': {
          if (!measured(record.at, record.at) || excluded(record.at, record.at)) break
          let active = minutes.get(buildKey)
          if (!active) { active = new Set(); minutes.set(buildKey, active) }
          active.add(Math.floor(record.at / 60_000))
          break
        }
        case 'profile':
          if ((profiles.get(buildKey)?.at ?? -1) <= record.at) profiles.set(buildKey, { at: record.at, id: record.profileId })
          break
        case 'span': case 'stall': {
          if (record.kind === 'span' && !record.blocking || record.kind === 'stall' && record.covered.length > 0
            || !measured(record.at - record.ms, record.at) || excluded(record.at - record.ms, record.at)) break
          const name = record.kind === 'span' ? record.name : 'unattributed'
          const key = `${buildKey}:${name}`
          let cluster = clusters.get(key)
          if (!cluster) {
            cluster = { process: record.process, name, build: record.build, selfMs: 0, count: 0, maxMs: 0,
              activeHours: 0, selfMsPerActiveHour: null, profileId: null }
            clusters.set(key, cluster)
          }
          if (Date.parse(record.build.builtAt) > Date.parse(cluster.build.builtAt)) cluster.build = record.build
          cluster.selfMs += record.kind === 'span' ? record.selfMs : record.ms
          cluster.count++
          cluster.maxMs = Math.max(cluster.maxMs, record.ms)
          break
        }
        case 'machine': case 'external': case 'runaway': case 'suspend': case 'resume': case 'truncated':
        case 'inputToFrame': case 'unresponsive': case 'hang': break
        default: throw new Error(`Unknown performance record: ${JSON.stringify(record)}`)
      }
      if (minutes.size > 256 || profiles.size > 256 || clusters.size > 4_096)
        throw new Error('Performance cluster history exceeds its bounded capacity')
    }
    for (const cluster of clusters.values()) {
      const buildKey = `${cluster.process}:${cluster.build.inputHash}`
      cluster.activeHours = (minutes.get(buildKey)?.size ?? 0) / 60
      cluster.selfMsPerActiveHour = cluster.activeHours > 0 ? cluster.selfMs / cluster.activeHours : null
      cluster.profileId = profiles.get(buildKey)?.id ?? null
    }
    return [...clusters.values()].filter(cluster => cluster.maxMs >= options.maxSpanMs
      || cluster.selfMsPerActiveHour !== null && cluster.selfMsPerActiveHour >= options.selfMsPerActiveHour)
      .sort((a, b) => (b.selfMsPerActiveHour ?? -1) - (a.selfMsPerActiveHour ?? -1) || b.maxMs - a.maxMs
        || a.process.localeCompare(b.process) || a.name.localeCompare(b.name))
  }

  private static mergeWindows(windows: { from: number; to: number }[]): { from: number; to: number }[] {
    const merged: { from: number; to: number }[] = []
    for (const window of windows.sort((a, b) => a.from - b.from)) {
      const last = merged.at(-1)
      if (last && window.from <= last.to) last.to = Math.max(last.to, window.to)
      else merged.push({ ...window })
    }
    return merged
  }

  private static windowAfter(windows: readonly { from: number; to: number }[], at: number): { from: number; to: number } | undefined {
    let low = 0, high = windows.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (windows[middle]!.to <= at) low = middle + 1
      else high = middle
    }
    return windows[low]
  }

  static summarize(records: readonly PerfRecord[], since: number, until: number, corruptLines = 0): PerfReport {
    const excludedWindows = PerfReportView.sleepWindows(records, since, until)
    const result: PerfReport = { samples: [], inputToFrame: [], activeHours: {}, top: [], operations: [], stalls: [], external: [], runaway: [],
      profiles: [], machine: [], excludedWindows, corruptLines }
    const minutes = new Map<PerfProcess, Set<number>>()
    const top = new Map<string, PerfReport['top'][number]>()
    const operations = new Map<string, PerfReport['operations'][number]>()
    for (const record of records) {
      if (record.at < since || record.at > until) continue
      const excluded = excludedWindows.some(window => record.at >= window.from && record.at < window.to)
      switch (record.kind) {
        case 'sample': {
          if (excluded) break
          result.samples.push(record)
          let active = minutes.get(record.process)
          if (!active) { active = new Set(); minutes.set(record.process, active) }
          active.add(Math.floor(record.at / 60_000))
          break
        }
        case 'span': {
          if (excluded) break
          const key = `${record.process}/${record.name}`
          if (!record.blocking) {
            let operation = operations.get(key)
            if (!operation) {
              operation = { process: record.process, name: record.name, ms: 0, count: 0 }
              operations.set(key, operation)
            }
            operation.ms += record.ms
            operation.count++
            break
          }
          let row = top.get(key)
          if (!row) {
            row = { process: record.process, name: record.name, selfMs: 0, selfMsPerActiveHour: null, count: 0 }
            top.set(key, row)
          }
          row.selfMs += record.selfMs
          row.count++
          break
        }
        case 'stall': if (!excluded) result.stalls.push(record); break
        case 'external': result.external.push(record); break
        case 'runaway': if (!excluded) result.runaway.push(record); break
        case 'profile': result.profiles.push(record); break
        case 'suspend': case 'resume': case 'truncated': case 'unresponsive': case 'hang':
          break
        case 'machine': result.machine.push(record); break
        case 'inputToFrame': if (!excluded) result.inputToFrame.push(record); break
        default: throw new Error(`Unknown performance record: ${JSON.stringify(record)}`)
      }
    }
    for (const [process, active] of minutes) result.activeHours[process] = active.size / 60
    for (const row of top.values()) {
      const hours = result.activeHours[row.process]
      if (hours !== undefined && hours > 0) row.selfMsPerActiveHour = row.selfMs / hours
    }
    result.top = [...top.values()].sort((a, b) => (b.selfMsPerActiveHour ?? -1) - (a.selfMsPerActiveHour ?? -1)
      || b.selfMs - a.selfMs || a.process.localeCompare(b.process) || a.name.localeCompare(b.name))
    result.stalls.sort((a, b) => b.ms - a.ms)
    result.operations = [...operations.values()].sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name))
    result.profiles.sort((a, b) => b.at - a.at)
    return result
  }

  static sleepWindows(records: readonly Pick<PerfRecord, 'kind' | 'at'>[], since: number, until: number): PerfReport['excludedWindows'] {
    const result: PerfReport['excludedWindows'] = []
    let suspended: number | null = null
    for (const record of [...records].sort((a, b) => a.at - b.at)) {
      if (record.at > until) continue
      if (record.kind === 'suspend') suspended ??= record.at
      else if (record.kind === 'resume') {
        if (suspended !== null && record.at >= since) result.push({ from: suspended, to: record.at, reason: 'suspend' })
        if (record.at + 60_000 >= since) result.push({ from: record.at, to: record.at + 60_000, reason: 'resume' })
        suspended = null
      }
    }
    if (suspended !== null) result.push({ from: suspended, to: until + 1, reason: 'suspend' })
    return result
  }
}
