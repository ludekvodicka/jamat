import { describe, expect, it } from 'vitest'
import xtermHeadless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { TerminalProjection } from '../terminal/terminalProjection.js'
import { HostWireConst, type TerminalSnapshotFrame, type TerminalSnapshotHeader } from '../wire/hostWire.js'
import { SnapshotStream } from './snapshotStream.js'

const header: TerminalSnapshotHeader = { runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1,
  outputSeq: 1, cols: 500, rows: 40, alive: true, lastOutputAt: 1 }

describe('SnapshotStream', () => {
  it('requires one credit per bounded scalar-safe frame and a final consumed acknowledgement', async () => {
    const frames: TerminalSnapshotFrame[] = []
    let finished = 0
    const stream = new SnapshotStream('stream', async () => ({ projection: header,
      screen: 'x'.repeat(8_191) + '😀' + '\u001b[?1049h', reset: true }), frame => frames.push(frame), () => finished++)
    expect(frames).toEqual([])
    await stream.pull('old', 0)
    expect(frames).toEqual([])
    await stream.pull('stream', 0)
    await stream.pull('stream', 0)
    expect(frames).toHaveLength(1)
    await expect(stream.pull('stream', 2)).rejects.toThrow('credit')
    await stream.pull('stream', 1)
    expect(frames[1]).toEqual({ type: 'terminal.snapshot-chunk', streamId: 'stream', index: 1, data: 'x'.repeat(8_191) })
    await stream.pull('stream', 2)
    expect(frames[2]).toEqual({ type: 'terminal.snapshot-chunk', streamId: 'stream', index: 2, data: '😀\u001b[?1049h' })
    await stream.pull('stream', 3)
    expect(frames[3]?.type).toBe('terminal.snapshot-end')
    expect(finished).toBe(0)
    await stream.pull('stream', 4)
    await stream.pull('stream', 4)
    expect(finished).toBe(1)
    expect(frames.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= HostWireConst.maxSnapshotFrameBytes)).toBe(true)
  })

  it('discards a pending source after cancellation without sending or finishing', async () => {
    let resolve!: (value: { projection: TerminalSnapshotHeader; screen: string; reset: boolean }) => void
    const sent: TerminalSnapshotFrame[] = []
    let finished = 0
    const stream = new SnapshotStream('old', () => new Promise(done => { resolve = done }),
      frame => sent.push(frame), () => finished++)
    const pending = stream.pull('old', 0)
    stream.close()
    resolve({ projection: header, screen: 'stale', reset: true })
    await pending
    expect(sent).toEqual([])
    expect(finished).toBe(0)
  })

  it('preserves the entire real oversized projection, both buffers, cursor, Unicode and mouse modes', async () => {
    const projection = new TerminalProjection('wide', 1, 1, 500, 40)
    const make = () => {
      const terminal = new xtermHeadless.Terminal({ cols: 500, rows: 40, scrollback: 1_000, allowProposedApi: true })
      terminal.loadAddon(new Unicode11Addon())
      terminal.unicode.activeVersion = '11'
      const serializer = new SerializeAddon()
      terminal.loadAddon(serializer)
      return { terminal, serializer }
    }
    const expected = make(), actual = make()
    try {
      const row = '\u001b[31mx\u001b[32my'.repeat(250) + '\r\n'
      for (let batch = 0; batch < 11; batch++) {
        projection.append(row.repeat(100))
        await projection.snapshot(true, TerminalProjection.attachOptionsConst)
      }
      projection.append('\u001b[?1049h\u001b[?1003h\u001b[?1006hALT 😀 終\u001b[5;9Hcursor')
      const snapshot = await projection.snapshot(true, TerminalProjection.attachOptionsConst)
      expect(Buffer.byteLength(JSON.stringify({ type: 'terminal.snapshot', projection: snapshot }))).toBeGreaterThan(2 * 1024 * 1024)
      await new Promise<void>(resolve => expected.terminal.write(snapshot.screen, resolve))
      let frame: TerminalSnapshotFrame | null = null
      let done = false
      let chunks = 0
      const stream = new SnapshotStream('large', async () => ({ projection: { ...header, outputSeq: snapshot.outputSeq },
        screen: snapshot.screen, reset: true }), value => { frame = value }, () => { done = true })
      const maximumPulls = Math.ceil(snapshot.screen.length / 8_191) + 3
      for (let index = 0; !done && index < maximumPulls; index++) {
        frame = null
        await stream.pull('large', index)
        const received = frame as TerminalSnapshotFrame | null
        if (received === null) continue
        expect(Buffer.byteLength(JSON.stringify(received))).toBeLessThanOrEqual(HostWireConst.maxSnapshotFrameBytes)
        if (received.type === 'terminal.snapshot-chunk') {
          chunks++
          await new Promise<void>(resolve => actual.terminal.write(received.data, resolve))
        }
      }
      expect(done).toBe(true)
      expect(chunks).toBeGreaterThan(100)
      expect(actual.serializer.serialize()).toEqual(expected.serializer.serialize())
      expect(actual.terminal.buffer.active.type).toBe('alternate')
      expect(actual.terminal.modes.mouseTrackingMode).toBe('any')
      expect([actual.terminal.buffer.active.cursorX, actual.terminal.buffer.active.cursorY])
        .toEqual([expected.terminal.buffer.active.cursorX, expected.terminal.buffer.active.cursorY])
      const replies: string[] = []
      actual.terminal.onData(value => replies.push(value))
      await new Promise<void>(resolve => actual.terminal.write('\u001b[?1006$p\u001b[?1016$p', resolve))
      expect(replies).toEqual(['\u001b[?1006;1$y', '\u001b[?1016;2$y'])
      await new Promise<void>(resolve => actual.terminal.write('\u001b[?1049l', resolve))
      await new Promise<void>(resolve => expected.terminal.write('\u001b[?1049l', resolve))
      expect(actual.serializer.serialize()).toEqual(expected.serializer.serialize())
    } finally { projection.dispose(); expected.terminal.dispose(); actual.terminal.dispose() }
  }, 30_000)
})
