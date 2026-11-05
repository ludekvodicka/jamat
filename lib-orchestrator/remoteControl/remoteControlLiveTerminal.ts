import { randomUUID } from 'node:crypto'
import type { TerminalAttachResult, TerminalAttachSpec, TerminalFrame } from '../sessionManager/sessionManagerApi.types'
import type { TerminalPort } from '../sessionManager/terminalPort'
import type { PastedFileChunk, PastedFileStore } from '../pastedFiles/pastedFileStore'
import { ErrorText } from '../shared/errorText'
import type { RemoteControlError, RemoteControlStepResult } from './remoteControlApi.types'

export interface RemoteControlLiveTerminalAttachDto {
  attachId: string
  sessionId: string
}

export interface RemoteControlLiveTerminalInputDto {
  attachId: string
  accepted: true
  characterCount: number
}

export interface RemoteControlLiveTerminalPasteImageDto {
  attachId: string
  /** The saved file on THIS computer, which the caller pastes into the prompt as text. */
  path: string
}

export interface RemoteControlLiveTerminalPasteFileDto {
  attachId: string
  /** Bytes saved so far. */
  received: number
  /** The saved file on THIS computer once the last chunk arrived, null before. */
  path: string | null
}

export interface RemoteControlLiveTerminalResizeDto {
  attachId: string
  accepted: true
  applied: boolean
}

interface LiveTerminalAttachment {
  internalAttachId: string
  sessionId: string
}

export interface RemoteControlLiveTerminalDeps {
  internalAttachId?(): string
  onError(message: string): void
  files?: Pick<PastedFileStore, 'saveImage' | 'receive'>
}

export class RemoteControlLiveTerminal {
  private readonly terminals: Pick<TerminalPort, 'attach' | 'input' | 'resize' | 'setGeometryActive' | 'detach' | 'detachAll'>
  private readonly deps: RemoteControlLiveTerminalDeps
  private readonly internalAttachId: () => string
  private readonly liveByOwner: Map<string, Map<string, LiveTerminalAttachment>>

  constructor(terminals: RemoteControlLiveTerminal['terminals'], deps: RemoteControlLiveTerminalDeps) {
    this.terminals = terminals
    this.deps = deps
    this.internalAttachId = deps.internalAttachId ?? randomUUID
    this.liveByOwner = new Map()
  }

  async attachLive(
    ownerId: string,
    attachId: string,
    spec: TerminalAttachSpec,
    onFrame: (frame: TerminalFrame) => void,
  ): Promise<RemoteControlStepResult<RemoteControlLiveTerminalAttachDto>> {
    const owned = this.liveByOwner.get(ownerId)
    if (owned?.has(attachId))
      return RemoteControlLiveTerminal.error(
        'conflict',
        `Terminal attach ${JSON.stringify(attachId)} already exists`,
      )
    const ownerAttachments = owned ?? new Map<string, LiveTerminalAttachment>()
    if (!owned) this.liveByOwner.set(ownerId, ownerAttachments)
    const live = {
      internalAttachId: `control-live:${this.internalAttachId()}`,
      sessionId: spec.sessionId,
    }
    ownerAttachments.set(attachId, live)
    let attached: TerminalAttachResult
    try {
      attached = await this.terminals.attach(live.internalAttachId, spec, {
        source: 'remote',
        onFrame: (frame) => this.liveFrame(ownerId, attachId, live, frame, onFrame),
      })
    } catch (error) {
      this.forgetLive(ownerId, attachId, live)
      this.terminals.detach(live.internalAttachId)
      throw error
    }
    if (this.liveByOwner.get(ownerId)?.get(attachId) !== live) {
      if (attached.ok) this.terminals.detach(live.internalAttachId)
      return RemoteControlLiveTerminal.error('unavailable', 'The terminal attach disappeared')
    }
    if (!attached.ok) {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlLiveTerminal.attachError(attached)
    }
    return RemoteControlLiveTerminal.success({ attachId, sessionId: spec.sessionId })
  }

  async inputLive(
    ownerId: string,
    attachId: string,
    data: string,
  ): Promise<RemoteControlStepResult<RemoteControlLiveTerminalInputDto>> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlLiveTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const input = await this.terminals.input(live.internalAttachId, data)
    if (input.kind === 'sent')
      return RemoteControlLiveTerminal.success({
        attachId,
        accepted: true,
        characterCount: data.length,
      })
    else if (input.kind === 'not-writer')
      return RemoteControlLiveTerminal.error('conflict', 'The terminal attach is read-only')
    else if (input.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlLiveTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal input result: ${JSON.stringify(input)}`)
  }

  async resizeLive(
    ownerId: string,
    attachId: string,
    cols: number,
    rows: number,
  ): Promise<RemoteControlStepResult<RemoteControlLiveTerminalResizeDto>> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlLiveTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const resized = await this.terminals.resize(live.internalAttachId, cols, rows)
    if (resized.kind === 'applied' || resized.kind === 'ignored')
      return RemoteControlLiveTerminal.success({
        attachId,
        accepted: true,
        applied: resized.kind === 'applied',
      })
    else if (resized.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlLiveTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal resize result: ${JSON.stringify(resized)}`)
  }

  async setLiveActive(
    ownerId: string,
    attachId: string,
    active: boolean,
  ): Promise<RemoteControlStepResult<RemoteControlLiveTerminalResizeDto>> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlLiveTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const resized = await this.terminals.setGeometryActive(live.internalAttachId, active)
    if (resized.kind === 'applied' || resized.kind === 'ignored')
      return RemoteControlLiveTerminal.success({
        attachId,
        accepted: true,
        applied: resized.kind === 'applied',
      })
    else if (resized.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlLiveTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal resize result: ${JSON.stringify(resized)}`)
  }

  /**
   * An image from the controller's clipboard, saved here under the attach's session. Only saved: the
   * path goes back to the controller, which pastes it through `terminal.input` like any other text,
   * so the one writer of a remote prompt stays the person's own keys.
   */
  async pasteImageLive(
    ownerId: string,
    attachId: string,
    bytes: Uint8Array,
  ): Promise<RemoteControlStepResult<RemoteControlLiveTerminalPasteImageDto>> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlLiveTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    if (this.deps.files === undefined)
      return RemoteControlLiveTerminal.error('operation-failed', 'This computer keeps no pasted files')
    const saved = await this.deps.files.saveImage(live.sessionId, bytes)
    if (!saved.ok) return RemoteControlLiveTerminal.error('operation-failed', saved.detail)
    return RemoteControlLiveTerminal.success({ attachId, path: saved.path })
  }

  /**
   * One chunk of a file the controller's clipboard named, saved here under the attach's session. As
   * with an image, only saved: `path` is null until the last chunk, and the controller pastes it.
   */
  async pasteFileLive(
    ownerId: string,
    attachId: string,
    uploadId: string,
    chunk: PastedFileChunk,
  ): Promise<RemoteControlStepResult<RemoteControlLiveTerminalPasteFileDto>> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlLiveTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    if (this.deps.files === undefined)
      return RemoteControlLiveTerminal.error('operation-failed', 'This computer keeps no pasted files')
    const received = await this.deps.files.receive(JSON.stringify([ownerId, uploadId]), live.sessionId, chunk)
    if (!received.ok) return RemoteControlLiveTerminal.error('operation-failed', received.detail)
    else if (received.kind === 'partial')
      return RemoteControlLiveTerminal.success({ attachId, received: received.received, path: null })
    else if (received.kind === 'complete')
      return RemoteControlLiveTerminal.success({ attachId, received: chunk.size, path: received.path })
    else
      throw new Error(`Unknown pasted file result: ${JSON.stringify(received)}`)
  }

  detachLive(ownerId: string, attachId: string): RemoteControlStepResult<{ attachId: string }> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlLiveTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    this.forgetLive(ownerId, attachId, live)
    this.terminals.detach(live.internalAttachId)
    return RemoteControlLiveTerminal.success({ attachId })
  }

  detachOwner(ownerId: string): void {
    const owned = this.liveByOwner.get(ownerId)
    if (!owned) return
    this.liveByOwner.delete(ownerId)
    this.terminals.detachAll(
      [...owned.values()].map((live) => live.internalAttachId),
    )
  }

  private liveFrame(
    ownerId: string,
    attachId: string,
    live: LiveTerminalAttachment,
    frame: TerminalFrame,
    onFrame: (frame: TerminalFrame) => void,
  ): void {
    if (this.liveByOwner.get(ownerId)?.get(attachId) !== live)
      return
    try {
      onFrame(frame)
    } catch (error) {
      this.deps.onError(`Live remote terminal frame failed: ${ErrorText.of(error)}`)
      this.forgetLive(ownerId, attachId, live)
      this.terminals.detach(live.internalAttachId)
      return
    }
    if (frame.type === 'terminal.exit'
      || (frame.type === 'terminal.status' && frame.status === 'lost'))
      this.forgetLive(ownerId, attachId, live)
  }

  private forgetLive(ownerId: string, attachId: string, live: LiveTerminalAttachment): void {
    const owned = this.liveByOwner.get(ownerId)
    if (owned?.get(attachId) !== live)
      return
    owned.delete(attachId)
    if (owned.size === 0) this.liveByOwner.delete(ownerId)
  }

  private static attachError<T>(
    answer: Exclude<TerminalAttachResult, { ok: true }>,
  ): RemoteControlStepResult<T> {
    if (answer.code === 'host-unreachable')
      return RemoteControlLiveTerminal.error('unavailable', answer.detail)
    else if (answer.code === 'not-live' || answer.code === 'unknown-session')
      return RemoteControlLiveTerminal.error('not-found', answer.detail)
    else
      throw new Error(`Unknown terminal attach refusal: ${JSON.stringify(answer)}`)
  }

  private static success<T>(value: T): RemoteControlStepResult<T> {
    return { ok: true, value }
  }

  private static error<T>(
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlStepResult<T> {
    return { ok: false, error: { code, detail } }
  }
}
