import type { RuntimeRef, TerminalSnapshotFrame } from '../../../app-host/app/wire/hostWire.js'
import type { TerminalAttachResult, TerminalAttachSpec, TerminalFrame } from '../sessionManagerApi.types'

export type TerminalAttachSource = 'local' | 'remote'

export interface TerminalAttachOwner {
  source: TerminalAttachSource
  windowId?: string
  onFrame(frame: TerminalFrame): void
  snapshotFlow?: TerminalSnapshotFlow
}

export interface TerminalSnapshotSlot {
  send(frame: TerminalSnapshotFrame): Promise<void>
  release(): void
}

export interface TerminalSnapshotFlow {
  reserve(frameBytesMax: number, signal: AbortSignal): Promise<TerminalSnapshotSlot>
}

export type TerminalInputResult =
  | { kind: 'sent' }
  | { kind: 'not-writer' }
  | { kind: 'unknown-attach' }

export type TerminalResizeResult =
  | { kind: 'applied' }
  | { kind: 'ignored' }
  | { kind: 'unknown-attach' }

export interface InputInhibit { release(): void }
export interface EditTransaction {
  write(data: string): Promise<TerminalInputResult | { refused: 'disconnected' }>
  end(): void
}
export type TerminalTransactionResult = EditTransaction | { refused: 'busy' | 'not-writer' }
export interface TerminalPort {
  /** Missing on older implementations means that only atomic snapshots are supported. */
  readonly capabilities?: { readonly snapshotStreaming: boolean }
  attach(attachId: string, spec: TerminalAttachSpec, owner: TerminalAttachOwner): Promise<TerminalAttachResult>
  input(attachId: string, data: string): Promise<TerminalInputResult>
  resize(attachId: string, cols: number, rows: number): Promise<TerminalResizeResult>
  setGeometryActive(attachId: string, active: boolean): Promise<TerminalResizeResult>
  detach(attachId: string): void
  detachAll(attachIds: readonly string[]): void
  inhibit(sessionId: string): Promise<InputInhibit>
  transaction(attachId: string): Promise<TerminalTransactionResult>
  pendingInput(sessionId: string): Promise<number>
  authorize(windowId: string, attachId: string): Promise<{ sessionId: string } | { refused: true }>
}

export type TerminalInputControl = Pick<TerminalPort, 'inhibit' | 'pendingInput'>

/** Where the ref came from matters to the caller: an ended session and an unknown one differ. */
export type TerminalRefResolution =
  /**
   * `alive` is false for a runtime the Host still HAS and no longer runs. Such a session is worth
   * attaching to: the Host keeps its output, and the last screen a process printed before it died is
   * the whole answer to why it died. It is attached to as an observer, because there is nothing left
   * to type at.
   */
  | { ok: true; ref: RuntimeRef; alive: boolean }
  | { ok: false; code: 'not-live' | 'unknown-session' }

export type TerminalRefChange = { sessionId: string; resolution: TerminalRefResolution }
export interface TerminalSessionsFeed {
  publishRefs(changes: readonly TerminalRefChange[]): Promise<void>
}
export interface TerminalActivitySink {
  userInput(marks: readonly { sessionId: string; at: number }[]): void
  pendingInputHint(counts: ReadonlyMap<string, number>): void
}
