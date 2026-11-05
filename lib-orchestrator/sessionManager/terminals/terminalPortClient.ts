import { randomUUID } from 'node:crypto'
import type { ProcessCalls } from '../../shared/processCalls'
import type { TerminalAttachResult, TerminalAttachSpec } from '../sessionManagerApi.types'
import type { TerminalProcessEvent, TerminalProcessMethods } from '../terminalProcess.types'
import type { EditTransaction, InputInhibit, TerminalActivitySink, TerminalAttachOwner, TerminalInputResult,
  TerminalPort, TerminalRefChange, TerminalResizeResult, TerminalSessionsFeed, TerminalTransactionResult } from './terminalPort'

interface Attachment { id: string; owner: TerminalAttachOwner }

export class TerminalPortClient implements TerminalPort, TerminalSessionsFeed {
  readonly capabilities = { snapshotStreaming: false }
  private readonly calls: ProcessCalls
  private readonly activity: TerminalActivitySink
  private readonly attachments: Map<string, Attachment>
  private readonly frames: Map<string, Attachment>

  constructor(calls: ProcessCalls, activity: TerminalActivitySink) {
    this.calls = calls
    this.activity = activity
    this.attachments = new Map()
    this.frames = new Map()
  }

  async attach(attachId: string, spec: TerminalAttachSpec, owner: TerminalAttachOwner): Promise<TerminalAttachResult> {
    if (owner.snapshotFlow) throw new Error('This terminal transport does not support snapshot streaming')
    this.detach(attachId)
    const attachment: Attachment = { id: randomUUID(), owner }
    this.attachments.set(attachId, attachment)
    this.frames.set(attachment.id, attachment)
    try {
      const result = await this.call<TerminalAttachResult>('attach', [attachment.id, spec, { source: owner.source, windowId: owner.windowId }],
        () => this.invalidate(attachId, attachment))
      if (!result.ok || this.attachments.get(attachId) !== attachment) {
        this.invalidate(attachId, attachment)
        this.calls.emit('terminals', 'detach', attachment.id)
      }
      return result
    } catch (error) {
      this.invalidate(attachId, attachment)
      throw error
    }
  }

  input(attachId: string, data: string): Promise<TerminalInputResult> {
    const attachment = this.attachments.get(attachId)
    return attachment ? this.call('input', [attachment.id, data], () => this.invalidate(attachId, attachment))
      : Promise.resolve({ kind: 'unknown-attach' })
  }

  resize(attachId: string, cols: number, rows: number): Promise<TerminalResizeResult> {
    const attachment = this.attachments.get(attachId)
    return attachment ? this.call('resize', [attachment.id, cols, rows]) : Promise.resolve({ kind: 'unknown-attach' })
  }

  setGeometryActive(attachId: string, active: boolean): Promise<TerminalResizeResult> {
    const attachment = this.attachments.get(attachId)
    return attachment ? this.call('active', [attachment.id, active]) : Promise.resolve({ kind: 'unknown-attach' })
  }

  authorize(windowId: string, attachId: string): Promise<{ sessionId: string } | { refused: true }> {
    const attachment = this.attachments.get(attachId)
    return attachment ? this.call('authorize', [windowId, attachment.id]) : Promise.resolve({ refused: true })
  }

  detach(attachId: string): void {
    const attachment = this.attachments.get(attachId)
    if (!attachment) return
    this.invalidate(attachId, attachment)
    this.calls.emit('terminals', 'detach', attachment.id)
  }

  detachAll(attachIds: readonly string[]): void { for (const id of attachIds) this.detach(id) }

  async inhibit(sessionId: string): Promise<InputInhibit> {
    const { token } = await this.call<{ token: string }>('inhibit', [sessionId])
    let released = false
    return { release: () => {
      if (released) return
      released = true
      this.calls.emit('terminals', 'release', token)
    } }
  }

  async transaction(attachId: string): Promise<TerminalTransactionResult> {
    const attachment = this.attachments.get(attachId)
    if (!attachment) return { refused: 'not-writer' }
    let valid = true
    const result = await this.call<{ token: string } | { refused: 'busy' | 'not-writer' }>('transaction', [attachment.id], () => { valid = false })
    if ('refused' in result) return result
    if (this.attachments.get(attachId) !== attachment) {
      this.calls.emit('terminals', 'end', result.token)
      return { refused: 'not-writer' }
    }
    const transaction: EditTransaction = {
      write: data => valid && this.attachments.get(attachId) === attachment
        ? this.call('write', [result.token, data], () => { valid = false }) : Promise.resolve({ refused: 'disconnected' }),
      end: () => {
        if (!valid) return
        valid = false
        this.calls.emit('terminals', 'end', result.token)
      },
    }
    return transaction
  }

  pendingInput(sessionId: string): Promise<number> { return this.call('pendingInput', [sessionId]) }
  publishRefs(changes: readonly TerminalRefChange[]): Promise<void> { return this.call('publishRefs', [changes]) }

  async close(): Promise<void> {
    this.attachments.clear()
    this.frames.clear()
    await this.call('close', [])
  }

  receive(event: TerminalProcessEvent): void {
    switch (event.name) {
      case 'frame': this.frames.get(event.payload.attachId)?.owner.onFrame(event.payload.frame); return
      case 'userInput': this.activity.userInput(event.payload); return
      case 'pendingInputHint': this.activity.pendingInputHint(new Map(event.payload)); return
      default: throw new Error(`Unknown terminal event: ${(event as { name: string }).name}`)
    }
  }

  private invalidate(attachId: string, attachment: Attachment): void {
    if (this.attachments.get(attachId) === attachment) this.attachments.delete(attachId)
    this.frames.delete(attachment.id)
  }

  private call<T>(method: keyof TerminalProcessMethods, args: TerminalProcessMethods[typeof method], invalidate?: () => void): Promise<T> {
    return this.calls.call<T>('terminals', method, args, { invalidate })
  }
}
