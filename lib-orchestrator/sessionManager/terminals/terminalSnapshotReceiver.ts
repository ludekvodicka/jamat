import { randomUUID } from 'node:crypto'
import type { HostWireConst, HostWsClientMsg, TerminalSnapshotFrame, TerminalSnapshotHeader } from '../../../app-host/app/wire/hostWire.js'
import type { TerminalSnapshotFlow, TerminalSnapshotSlot } from './terminalPort'

export class TerminalSnapshotReceiver {
  private static readonly frameBytesMax: typeof HostWireConst.maxSnapshotFrameBytes = 65_536
  readonly id: string
  private readonly flow: TerminalSnapshotFlow
  private readonly send: (message: HostWsClientMsg) => void
  private readonly completed: (projection: TerminalSnapshotHeader) => void
  private readonly failed: (error: unknown) => void
  private readonly abort: AbortController
  private slot: TerminalSnapshotSlot | null
  private projection: TerminalSnapshotHeader | null
  private index: number
  private started: boolean
  private waiting: boolean
  private consumed: boolean

  constructor(flow: TerminalSnapshotFlow, send: TerminalSnapshotReceiver['send'],
    completed: TerminalSnapshotReceiver['completed'], failed: TerminalSnapshotReceiver['failed']) {
    this.flow = flow
    this.send = send
    this.completed = completed
    this.failed = failed
    this.id = randomUUID()
    this.abort = new AbortController()
    this.slot = null
    this.projection = null
    this.index = 0
    this.started = false
    this.waiting = false
    this.consumed = false
  }

  start(): void {
    if (this.started || this.abort.signal.aborted) return
    this.started = true
    void this.pull()
  }

  receive(frame: TerminalSnapshotFrame): void {
    if (this.abort.signal.aborted || frame.streamId !== this.id) return
    if (!Number.isSafeInteger(frame.index) || frame.index < 0) throw new Error('Invalid snapshot frame sequence')
    if (Number.isSafeInteger(frame.index) && frame.index < this.index) return
    if (!this.waiting || frame.index !== this.index || this.slot === null)
      throw new Error('Unexpected snapshot frame or sequence')
    if (frame.type === 'terminal.snapshot-start') {
      if (this.projection || this.index !== 0) throw new Error('Duplicate snapshot start')
      this.projection = frame.projection
    } else if (frame.type === 'terminal.snapshot-chunk' || frame.type === 'terminal.snapshot-end') {
      if (!this.projection) throw new Error('Snapshot data preceded its header')
    } else throw new Error(`Unknown snapshot frame: ${(frame as { type: string }).type}`)
    this.waiting = false
    const slot = this.slot
    this.slot = null
    void slot.send(frame).then(() => {
      if (this.abort.signal.aborted) return
      this.index++
      if (frame.type === 'terminal.snapshot-end') {
        this.consumed = true
        this.completed(this.projection!)
        this.send({ type: 'terminal.snapshot-next', streamId: this.id, index: this.index })
        this.close()
      } else void this.pull()
    }).catch(error => this.fail(error))
  }

  close(): void {
    this.abort.abort()
    this.slot?.release()
    this.slot = null
  }

  acceptsCompletion(streamId: string): boolean { return streamId === this.id && this.consumed }

  private async pull(): Promise<void> {
    try {
      const slot = await this.flow.reserve(TerminalSnapshotReceiver.frameBytesMax, this.abort.signal)
      if (this.abort.signal.aborted) { slot.release(); return }
      this.slot = slot
      this.waiting = true
      this.send({ type: 'terminal.snapshot-next', streamId: this.id, index: this.index })
    } catch (error) { this.fail(error) }
  }

  private fail(error: unknown): void {
    if (this.abort.signal.aborted) return
    this.close()
    this.failed(error)
  }
}
