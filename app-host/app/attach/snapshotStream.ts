import { HostWireConst, type TerminalSnapshotFrame, type TerminalSnapshotHeader } from '../wire/hostWire.js'

export class SnapshotStream {
  private readonly id: string
  private readonly source: () => Promise<{ projection: TerminalSnapshotHeader; screen: string; reset: boolean }>
  private readonly send: (frame: TerminalSnapshotFrame) => void
  private readonly finish: (projection: TerminalSnapshotHeader) => void
  private value: Awaited<ReturnType<SnapshotStream['source']>> | null
  private index: number
  private offset: number
  private busy: boolean
  private ended: boolean
  private closed: boolean

  constructor(id: string, source: SnapshotStream['source'], send: SnapshotStream['send'], finish: SnapshotStream['finish']) {
    this.id = id
    this.source = source
    this.send = send
    this.finish = finish
    this.value = null
    this.index = 0
    this.offset = 0
    this.busy = false
    this.ended = false
    this.closed = false
  }

  async pull(streamId: string, index: number): Promise<void> {
    if (this.closed || streamId !== this.id) return
    if (!Number.isSafeInteger(index) || index < 0 || index > this.index)
      throw new Error('Invalid snapshot stream credit')
    if (index < this.index || this.busy) return
    this.busy = true
    try {
      if (this.value === null) {
        const value = await this.source()
        if (this.closed) return
        this.value = value
        this.emit({ type: 'terminal.snapshot-start', streamId: this.id, index, reset: value.reset, projection: value.projection })
      } else if (this.offset < this.value.screen.length) {
        let end = Math.min(this.offset + 8_192, this.value.screen.length)
        const last = this.value.screen.charCodeAt(end - 1)
        if (end < this.value.screen.length && last >= 0xd800 && last <= 0xdbff) end--
        const data = this.value.screen.slice(this.offset, end)
        this.offset = end
        this.emit({ type: 'terminal.snapshot-chunk', streamId: this.id, index, data })
      } else if (!this.ended) {
        this.ended = true
        this.value.screen = ''
        this.emit({ type: 'terminal.snapshot-end', streamId: this.id, index })
      } else if (this.ended) {
        const projection = this.value.projection
        this.close()
        this.finish(projection)
      } else throw new Error('Unknown snapshot stream state')
    } finally { this.busy = false }
  }

  close(): void { this.closed = true; this.value = null }

  private emit(frame: TerminalSnapshotFrame): void {
    if (Buffer.byteLength(JSON.stringify(frame)) > HostWireConst.maxSnapshotFrameBytes)
      throw new Error('Snapshot frame exceeds its credit')
    this.index++
    this.send(frame)
  }
}
