import { describe, expect, it } from 'vitest'
import { TerminalOutput } from './terminalOutput'

class TerminalFixture {
  cols = 80
  rows = 24
  hold = false
  callbacks: (() => void)[] = []
  calls: unknown[][] = []
  write(data: string, done?: () => void): void {
    this.calls.push(['write', data, this.cols, this.rows])
    if (this.hold && done) this.callbacks.push(done)
    else done?.()
  }
  reset(): void { this.calls.push(['reset']) }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.calls.push(['resize', cols, rows]) }
}

const header = { runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, outputSeq: 20,
  cols: 100, rows: 30, alive: true, lastOutputAt: 1 }
const turn = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

describe('TerminalOutput', () => {
  it('serializes a pending write, resize and subsequent data in their received geometry order', async () => {
    const terminal = new TerminalFixture(), output = new TerminalOutput(terminal)
    terminal.hold = true
    const before = output.frame({ type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1,
      outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'before' })
    const resize = output.frame({ type: 'terminal.resize', runtimeSessionId: 'runtime', generation: 1, cols: 100, rows: 30 })
    const after = output.frame({ type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1,
      outputEpoch: 1, outputSeq: 2, lastOutputAt: 1, delta: 'after' })
    expect(terminal.calls).toEqual([['write', 'before', 80, 24]])
    terminal.callbacks.shift()!()
    await before; await resize; await turn()
    expect(terminal.calls).toEqual([['write', 'before', 80, 24], ['resize', 100, 30], ['write', 'after', 100, 30]])
    terminal.callbacks.shift()!()
    await after
    output.dispose()
  })

  it('parses hidden initial history without trimming and keeps frozen geometry through visibility and resize proposals', async () => {
    const terminal = new TerminalFixture(), output = new TerminalOutput(terminal)
    await output.setVisible(false)
    await output.frame({ type: 'terminal.snapshot-start', streamId: 's', index: 0, reset: true, projection: header })
    const chunks = ['A'.repeat(500_000), 'B'.repeat(500_000)]
    await output.frame({ type: 'terminal.snapshot-chunk', streamId: 's', index: 1, data: chunks[0]! })
    let fits = 0
    const fit = { fit: () => { fits++; terminal.resize(120, 40) }, proposeDimensions: () => ({ cols: 120, rows: 40 }) }
    expect(output.measure(fit)).toBeNull()
    await output.setVisible(true)
    await output.frame({ type: 'terminal.snapshot-chunk', streamId: 's', index: 2, data: chunks[1]! })
    await output.frame({ type: 'terminal.snapshot-end', streamId: 's', index: 3 })
    expect(output.measure(fit)).toEqual({ cols: 120, rows: 40 })
    expect(fits).toBe(0)
    expect(terminal.calls.filter(call => call[0] === 'write')).toEqual(chunks.map(chunk => ['write', chunk, 100, 30]))
    await output.frame({ type: 'terminal.resize', runtimeSessionId: 'runtime', generation: 1, cols: 120, rows: 40 })
    await output.frame({ type: 'terminal.snapshot-complete', streamId: 's' })
    expect(fits).toBe(1)
    output.dispose()
  })

  it('unlocks deferred fitting after the drained marker even when a read-only resize produced no event', async () => {
    const terminal = new TerminalFixture(), output = new TerminalOutput(terminal)
    await output.frame({ type: 'terminal.snapshot-start', streamId: 's', index: 0, reset: true, projection: { ...header, alive: false } })
    let fits = 0
    const fit = { fit: () => { fits++; terminal.resize(120, 40) }, proposeDimensions: () => ({ cols: 120, rows: 40 }) }
    output.measure(fit)
    await output.frame({ type: 'terminal.snapshot-end', streamId: 's', index: 1 })
    expect(fits).toBe(0)
    await output.frame({ type: 'terminal.snapshot-complete', streamId: 's' })
    expect(fits).toBe(1)
    output.measure(fit)
    expect(fits).toBe(2)
    output.dispose()
  })

  it('ignores stale completion and releases geometry protection on permanent loss behind queued parsing', async () => {
    const terminal = new TerminalFixture(), output = new TerminalOutput(terminal)
    await output.frame({ type: 'terminal.snapshot-start', streamId: 'new', index: 0, reset: true, projection: header })
    let fits = 0
    const fit = { fit: () => { fits++ }, proposeDimensions: () => ({ cols: 120, rows: 40 }) }
    output.measure(fit)
    await output.frame({ type: 'terminal.snapshot-complete', streamId: 'old' })
    expect(fits).toBe(0)
    terminal.hold = true
    const chunk = output.frame({ type: 'terminal.snapshot-chunk', streamId: 'new', index: 1, data: 'pending' })
    const lost = output.lost()
    expect(fits).toBe(0)
    terminal.callbacks.shift()!()
    await chunk; await lost
    expect(fits).toBe(1)
    output.dispose()
  })

  it('parses an accepted hidden atomic snapshot in full before ordinary hidden output resumes', async () => {
    const terminal = new TerminalFixture(), output = new TerminalOutput(terminal)
    await output.setVisible(false)
    const screen = 'start\u001b[31m' + 'x'.repeat(900_000) + '\u001b[?1049hend'
    await output.frame({ type: 'terminal.snapshot', projection: { ...header, screen } })
    expect(terminal.calls).toEqual([['reset'], ['resize', 100, 30], ['write', screen, 100, 30]])
    await output.frame({ type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1,
      outputEpoch: 1, outputSeq: 21, lastOutputAt: 1, delta: 'held' })
    expect(terminal.calls).toHaveLength(3)
    await output.setVisible(true)
    expect(terminal.calls.at(-1)).toEqual(['write', 'held', 100, 30])
    output.dispose()
  })

  it('flushes held output before a streamed replay and settles queued work on disposal', async () => {
    const terminal = new TerminalFixture(), output = new TerminalOutput(terminal)
    await output.setVisible(false)
    await output.frame({ type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1,
      outputEpoch: 1, outputSeq: 1, lastOutputAt: 1, delta: 'held' })
    terminal.hold = true
    const start = output.frame({ type: 'terminal.snapshot-start', streamId: 's', index: 0, reset: false, projection: header })
    const chunk = output.frame({ type: 'terminal.snapshot-chunk', streamId: 's', index: 1, data: 'later' })
    expect(terminal.calls).toEqual([['write', 'held', 80, 24]])
    output.dispose()
    await start; await chunk
    expect(terminal.calls).toEqual([['write', 'held', 80, 24]])
  })
})
