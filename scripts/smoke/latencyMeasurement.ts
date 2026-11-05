import assert from 'node:assert/strict'

export interface LatencyBoundary {
  kind: 'block'
  phase: 'start' | 'end'
  id: string
  process: 'main' | 'orchestrator'
  target: 'main' | 'orchestrator'
  pid: number
  milliseconds: 3000 | 20000
  at: number
  observedAt: number
}

export interface LatencySample {
  marker: string
  startedAt: number
  arrivedAt: number
  milliseconds: number
}

export interface LatencyStatusSample {
  operation: 'system.status'
  startedAt: number
  arrivedAt: number
  milliseconds: number
}

export class LatencyMeasurement {
  static command(marker: string, platform: NodeJS.Platform): string {
    assert.match(marker, /^M-[a-f0-9]{32}$/)
    const first = marker.slice(0, 18), second = marker.slice(18)
    let command: string
    switch (platform) {
      case 'win32': command = `for %A in (${first}) do @echo %A${second}\r`; break
      case 'linux': case 'darwin': command = `printf '%s%s\\n' '${first}' '${second}'\r`; break
      case 'aix': case 'android': case 'freebsd': case 'haiku': case 'openbsd': case 'sunos': case 'cygwin': case 'netbsd':
        throw new Error(`Latency smoke is unsupported on ${platform}`)
      default: throw new Error(`Unknown platform: ${platform}`)
    }
    assert(!command.includes(marker), 'The echoed command must not contain the output marker')
    return command
  }

  static check(sample: LatencySample, start?: LatencyBoundary, end?: LatencyBoundary): void {
    console.log(`[smoke:latency] measurement ${JSON.stringify({ sample, start, end })}`)
    const elapsed = sample.arrivedAt - sample.startedAt
    assert.equal(sample.milliseconds, elapsed, 'Reported latency must equal the external marker timestamps')
    assert(elapsed >= 0 && elapsed < 200,
      `Marker ${sample.marker}: ${sample.milliseconds.toFixed(2)} ms (limit 200 ms)`)
    assert(sample.arrivedAt >= sample.startedAt)
    if (!start && !end) return
    assert(start && end, 'Both externally observed block boundaries are required')
    LatencyMeasurement.inside(sample, start, end)
  }

  static checkStatus(sample: LatencyStatusSample, start: LatencyBoundary, end: LatencyBoundary): void {
    console.log('[smoke:latency] CLI measurement ' + JSON.stringify({ sample, start, end }))
    const elapsed = sample.arrivedAt - sample.startedAt
    assert.equal(sample.operation, 'system.status')
    assert.equal(sample.milliseconds, elapsed, 'CLI latency must include the entire shipped wrapper execution')
    assert(elapsed >= 0 && elapsed < 500, 'CLI status: ' + elapsed.toFixed(2) + ' ms (limit 500 ms)')
    assert.equal(start.process, 'main')
    LatencyMeasurement.inside(sample, start, end)
  }

  private static inside(sample: { startedAt: number; arrivedAt: number }, start: LatencyBoundary, end: LatencyBoundary): void {
    assert.equal(start.process, start.target)
    assert.equal(end.process, start.process)
    assert.equal(end.target, start.target)
    assert.equal(end.milliseconds, start.milliseconds)
    assert.equal(start.phase, 'start')
    assert.equal(end.phase, 'end')
    assert.equal(end.id, start.id)
    assert.equal(end.pid, start.pid)
    assert(end.at - start.at >= start.milliseconds, 'The process did not block for the requested duration')
    assert(sample.startedAt >= start.observedAt && start.observedAt >= start.at,
      'Input must follow externally confirmed block entry')
    assert(sample.arrivedAt < end.at && sample.arrivedAt < end.observedAt,
      'The output marker arrived after the block ended')
  }
}
