import { describe, expect, it } from 'vitest'

import type { HostHealthResult, HostMemorySample } from '../../../app-host/app/wire/hostWire.js'
import { HostMemoryReadings } from './hostMemoryReadings'

describe('lib-orchestrator/sessionManager/hostMemory/hostMemoryReadings', () => {
  const minute = 60_000
  const hour = 60 * minute
  const mebibyte = 1024 ** 2
  const startedAt = 1_000_000
  const started = new Date(startedAt).toLocaleString()

  /** One sample every ten minutes from the start, rss growing by `perSampleMegabytes`. */
  function health(uptime: number, firstMegabytes: number, perSampleMegabytes: number): HostHealthResult {
    const samples: HostMemorySample[] = []
    for (let at = 0; at <= uptime; at += 10 * minute) {
      const rss = (firstMegabytes + (at / (10 * minute)) * perSampleMegabytes) * mebibyte
      samples.push({ at: startedAt + at, rssBytes: rss, heapUsedBytes: 120 * mebibyte, externalBytes: mebibyte })
    }
    return { startedAt, sampleEveryMs: 10 * minute, samples }
  }

  it('reads every window a long uptime covers', () => {
    // 2 d 4 h, growing 1 MB per sample: 36 samples in 6 h, 72 in 12 h, 144 in 24 h
    const reading = HostMemoryReadings.of(health(52 * hour, 200, 1))

    expect(reading).toEqual({
      lines: [
        `Memory 512 MB (heap 120 MB), Host started ${started}`,
        'Growth: 6 h +36 MB · 12 h +72 MB · 24 h +144 MB',
      ],
      warning: null,
      suffix: null,
    })
  })

  it('says n/a for a window longer than the uptime, and why', () => {
    const reading = HostMemoryReadings.of(health(7 * hour, 200, 1))

    expect(reading.lines).toEqual([
      `Memory 242 MB (heap 120 MB), Host started ${started}`,
      'Growth: 6 h +36 MB · 12 h n/a · 24 h n/a (n/a: the Host has not run that long)',
    ])
    expect(reading.warning).toBeNull()
  })

  // UA1-J10-10: the reading is composed per ten-minute sample, so "up 0 min" stood six minutes after the start.
  it('names when the Host started rather than an uptime that is stale until the next sample', () => {
    const reading = HostMemoryReadings.of(health(0, 100, 0))

    expect(reading.lines[0]).toBe(`Memory 100 MB (heap 120 MB), Host started ${started}`)
    expect(reading.lines.join('\n')).not.toContain('up 0 min')
  })

  it('reads a Host up for minutes as all n/a without a warning', () => {
    const reading = HostMemoryReadings.of(health(20 * minute, 100, 200))

    expect(reading.lines[1]).toBe('Growth: 6 h n/a · 12 h n/a · 24 h n/a (n/a: the Host has not run that long)')
    // 400 MB grown, but under an hour of uptime is too little history to call it a leak
    expect(reading.warning).toBeNull()
  })

  it('warns on growth of 300 MB within a covered window, and marks the item', () => {
    // 3 MB per sample: 432 MB in 24 h, 216 MB in 12 h
    const reading = HostMemoryReadings.of(health(30 * hour, 200, 3))

    expect(reading.warning).toBe('Host memory grew 432 MB in 24 h')
    expect(reading.suffix).toBe(' · memory ↑')
    expect(reading.lines.at(-1)).toBe('Warning: Host memory grew 432 MB in 24 h')
  })

  it('names the shortest window that grew past the limit', () => {
    const reading = HostMemoryReadings.of(health(13 * hour, 200, 10))

    expect(reading.warning).toBe('Host memory grew 360 MB in 6 h')
  })

  it('warns on growth since start when the uptime covers an hour but not the window', () => {
    // 3 h up, 20 MB per sample: 360 MB since start, and no window covered past 6 h
    const reading = HostMemoryReadings.of(health(3 * hour, 200, 20))

    expect(reading.warning).toBe('Host memory grew 360 MB in 3 h since start')
  })

  it('warns when rss passes 1.5 GB, whatever the growth', () => {
    const reading = HostMemoryReadings.of(health(30 * hour, 1_600, 0))

    expect(reading.lines[0]).toBe(`Memory 1.6 GB (heap 120 MB), Host started ${started}`)
    expect(reading.warning).toBe('Host memory is 1.6 GB')
  })

  it('stays quiet at exactly 1.5 GB and below 300 MB of growth', () => {
    const reading = HostMemoryReadings.of(health(30 * hour, 1_536, 0))

    expect(reading.warning).toBeNull()
    expect(reading.lines[1]).toBe('Growth: 6 h +0 MB · 12 h +0 MB · 24 h +0 MB')
  })

  it('writes MB without decimals below 1024 MB and GB with one decimal from it', () => {
    expect(HostMemoryReadings.of(health(0, 1_023.4, 0)).lines[0]).toMatch(/^Memory 1023 MB /)
    expect(HostMemoryReadings.of(health(0, 1_023.6, 0)).lines[0]).toMatch(/^Memory 1.0 GB /)
    expect(HostMemoryReadings.of(health(0, 2_560, 0)).lines[0]).toMatch(/^Memory 2.5 GB /)
  })

  it('writes a shrinking window with its own sign', () => {
    const reading = HostMemoryReadings.of(health(7 * hour, 500, -1))

    expect(reading.lines[1]).toBe('Growth: 6 h -36 MB · 12 h n/a · 24 h n/a (n/a: the Host has not run that long)')
  })

  it('says a Host without host.health cannot report, and does not warn', () => {
    expect(HostMemoryReadings.notReportedConst).toEqual({
      lines: ['Memory: not reported by this Host (restart the Host to get it)'],
      warning: null,
      suffix: null,
    })
  })

  it('reads an answer with no sample without throwing', () => {
    expect(HostMemoryReadings.of({ startedAt, sampleEveryMs: 10 * minute, samples: [] }).warning).toBeNull()
  })
})
