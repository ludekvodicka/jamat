import type { HostHealthResult, HostMemorySample } from '../../../app-host/app/wire/hostWire.js'
import type { HostMemoryReading } from '../sessionManagerApi.types'

/**
 * What the Host's memory history says, in words. Pure: the reading is composed once per new answer
 * from the Host, and its "now" is the newest sample, so the same answer always reads the same.
 *
 * The thresholds come from the 2026-10-13 leak: about 6.5 MB per ended process, so a working day of
 * script runs grew the Host by hundreds of MB long before a create failed.
 */
export class HostMemoryReadings {
  static readonly windowsHoursConst = [6, 12, 24] as const
  static readonly rssLimitBytesConst = 1.5 * 1024 ** 3
  static readonly growthLimitBytesConst = 300 * 1024 ** 2
  /** Growth since start counts for a window the uptime does not cover yet, but not before this. */
  static readonly sinceStartMinimumMillisecondsConst = 60 * 60_000
  static readonly notReportedConst: HostMemoryReading = {
    lines: ['Memory: not reported by this Host (restart the Host to get it)'],
    warning: null,
    suffix: null,
  }
  private static readonly emptyConst: HostMemoryReading = {
    lines: ['Memory: the Host sent no sample'],
    warning: null,
    suffix: null,
  }
  private static readonly suffixConst = ' · memory ↑'
  private static readonly hourConst = 60 * 60_000
  private static readonly mebibyteConst = 1024 ** 2
  private static readonly gibibyteConst = 1024 ** 3

  static of(health: HostHealthResult): HostMemoryReading {
    // The answer crossed a socket unvalidated; an empty or broken history must not throw on the poll.
    const latest = Array.isArray(health.samples) ? health.samples.at(-1) : undefined
    if (latest === undefined) return HostMemoryReadings.emptyConst
    const uptime = latest.at - health.startedAt
    const windows = HostMemoryReadings.windowsHoursConst.map((hours) => ({
      hours,
      growth: uptime >= hours * HostMemoryReadings.hourConst
        ? HostMemoryReadings.growthWithin(health.samples, latest, hours * HostMemoryReadings.hourConst)
        : null,
    }))
    const growthText = windows
      .map((window) => `${window.hours} h ${window.growth === null ? 'n/a' : HostMemoryReadings.signed(window.growth)}`)
      .join(' · ')
    const uncovered = windows.some((window) => window.growth === null)
    const lines = [
      `Memory ${HostMemoryReadings.size(latest.rssBytes)} (heap ${HostMemoryReadings.size(latest.heapUsedBytes)}), `
        + `up ${HostMemoryReadings.duration(uptime)}`,
      `Growth: ${growthText}${uncovered ? ` (up ${HostMemoryReadings.duration(uptime)})` : ''}`,
    ]
    const warning = HostMemoryReadings.warningOf(health, latest, uptime, windows)
    if (warning === null) return { lines, warning: null, suffix: null }
    return { lines: [...lines, `Warning: ${warning}`], warning, suffix: HostMemoryReadings.suffixConst }
  }

  private static warningOf(
    health: HostHealthResult,
    latest: HostMemorySample,
    uptime: number,
    windows: readonly { hours: number; growth: number | null }[],
  ): string | null {
    if (latest.rssBytes > HostMemoryReadings.rssLimitBytesConst)
      return `Host memory is ${HostMemoryReadings.size(latest.rssBytes)}`
    for (const window of windows)
      if (window.growth !== null && window.growth >= HostMemoryReadings.growthLimitBytesConst)
        return `Host memory grew ${HostMemoryReadings.size(window.growth)} in ${window.hours} h`
    if (!windows.some((window) => window.growth === null)
      || uptime < HostMemoryReadings.sinceStartMinimumMillisecondsConst) return null
    const sinceStart = latest.rssBytes - health.samples[0].rssBytes
    return sinceStart >= HostMemoryReadings.growthLimitBytesConst
      ? `Host memory grew ${HostMemoryReadings.size(sinceStart)} in ${HostMemoryReadings.duration(uptime)} since start`
      : null
  }

  /** Measured from the oldest sample inside the window, which with a ten-minute cadence starts at most ten minutes late. */
  private static growthWithin(samples: readonly HostMemorySample[], latest: HostMemorySample, windowMilliseconds: number): number {
    const from = latest.at - windowMilliseconds
    const oldest = samples.find((sample) => sample.at >= from) ?? latest
    return latest.rssBytes - oldest.rssBytes
  }

  private static size(bytes: number): string {
    const mebibytes = Math.round(bytes / HostMemoryReadings.mebibyteConst)
    return Math.abs(mebibytes) >= 1024
      ? `${(bytes / HostMemoryReadings.gibibyteConst).toFixed(1)} GB`
      : `${mebibytes} MB`
  }

  private static signed(bytes: number): string {
    return bytes < 0 ? HostMemoryReadings.size(bytes) : `+${HostMemoryReadings.size(bytes)}`
  }

  private static duration(milliseconds: number): string {
    const minutes = Math.floor(milliseconds / 60_000)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    if (days > 0) return `${days} d ${hours % 24} h`
    if (hours > 0) return `${hours} h`
    return `${minutes} min`
  }
}
