import { describe, expect, it } from 'vitest'
import type { HostWsClientMsg, TerminalSnapshotFrame } from '../../../app-host/app/wire/hostWire.js'
import type { TerminalSnapshotFlow, TerminalSnapshotSlot } from './terminalPort'
import { TerminalSnapshotReceiver } from './terminalSnapshotReceiver'

const turn = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const projection = { runtimeSessionId: 'runtime', generation: 1, outputEpoch: 2, outputSeq: 99,
  cols: 100, rows: 30, alive: true, lastOutputAt: 1 }

describe('TerminalSnapshotReceiver', () => {
  it('pulls only after admission and actual consumption, and commits only after the end receipt', async () => {
    const wire: HostWsClientMsg[] = [], delivered: TerminalSnapshotFrame[] = [], commits: unknown[] = []
    const receipts: (() => void)[] = []
    const reserves: (() => void)[] = []
    const flow: TerminalSnapshotFlow = { reserve: (bytes, signal) => new Promise(resolve => {
      expect(bytes).toBe(65_536)
      expect(signal.aborted).toBe(false)
      reserves.push(() => resolve({ release() {}, send: frame => new Promise(done => { delivered.push(frame); receipts.push(done) }) }))
    }) }
    const receiver = new TerminalSnapshotReceiver(flow, frame => wire.push(frame), value => commits.push(value), error => { throw error })
    receiver.start()
    expect(wire).toEqual([])
    for (const frame of [
      { type: 'terminal.snapshot-start', index: 0, reset: true, projection },
      { type: 'terminal.snapshot-chunk', index: 1, data: 'screen' },
      { type: 'terminal.snapshot-end', index: 2 },
    ] as const) {
      reserves.shift()!()
      await turn()
      expect(wire.at(-1)).toEqual({ type: 'terminal.snapshot-next', streamId: receiver.id, index: frame.index })
      receiver.receive({ ...frame, streamId: receiver.id })
      await turn()
      expect(commits).toEqual([])
      expect(wire).toHaveLength(frame.index + 1)
      receipts.shift()!()
      await turn()
    }
    expect(delivered.map(frame => frame.type)).toEqual(['terminal.snapshot-start', 'terminal.snapshot-chunk', 'terminal.snapshot-end'])
    expect(commits).toEqual([projection])
    expect(wire.at(-1)).toEqual({ type: 'terminal.snapshot-next', streamId: receiver.id, index: 3 })
  })

  it('cancels queued credit and releases a late slot without pulling a replaced stream', async () => {
    let resolve!: (slot: TerminalSnapshotSlot) => void
    let signal!: AbortSignal
    let releases = 0
    const wire: HostWsClientMsg[] = []
    const receiver = new TerminalSnapshotReceiver({ reserve: (_bytes, value) => {
      signal = value
      return new Promise(done => { resolve = done })
    } }, frame => wire.push(frame), () => { throw new Error('must not commit') }, error => { throw error })
    receiver.start()
    receiver.close()
    expect(signal.aborted).toBe(true)
    resolve({ release: () => { releases++ }, send: async () => { throw new Error('must not send') } })
    await turn()
    expect(releases).toBe(1)
    expect(wire).toEqual([])
  })

  it('does not commit or return final credit when the renderer rejects a frame', async () => {
    const wire: HostWsClientMsg[] = [], failures: unknown[] = [], commits: unknown[] = []
    const receiver = new TerminalSnapshotReceiver({ reserve: async () => ({ release() {}, send: async () => { throw new Error('parser failed') } }) },
      frame => wire.push(frame), value => commits.push(value), error => failures.push(error))
    receiver.start()
    await turn()
    receiver.receive({ type: 'terminal.snapshot-start', streamId: receiver.id, index: 0, reset: true, projection })
    await turn()
    expect(wire).toHaveLength(1)
    expect(commits).toEqual([])
    expect(String(failures[0])).toContain('parser failed')
  })

  it('rejects out-of-order frames and ignores an obsolete stream identity', async () => {
    let sends = 0
    const receiver = new TerminalSnapshotReceiver({ reserve: async () => ({ release() {}, send: async () => { sends++ } }) },
      () => {}, () => {}, error => { throw error })
    receiver.start()
    await turn()
    receiver.receive({ type: 'terminal.snapshot-end', streamId: 'old', index: 0 })
    expect(sends).toBe(0)
    expect(() => receiver.receive({ type: 'terminal.snapshot-start', streamId: receiver.id, index: 1, reset: true, projection })).toThrow('sequence')
    receiver.close()
  })
})
