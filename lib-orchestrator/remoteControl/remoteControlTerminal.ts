import { randomUUID } from 'node:crypto'

import type {
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalFrame,
} from '../sessionManager/sessionManagerApi.types'
import type {
  TerminalAttachOwner,
  TerminalInputResult,
  TerminalResizeResult,
} from '../sessionManager/terminals/terminalGateway'
import { ErrorText } from '../shared/errorText'
import type { RemoteControlTerminalPort } from './remoteControl'
import type {
  RemoteControlError,
  RemoteControlStepResult,
  RemoteControlTerminalPeekDto,
  RemoteControlTerminalSendDto,
} from './remoteControlApi.types'

export interface RemoteControlTerminalSessionPort {
  terminalAttach(
    attachId: string,
    spec: TerminalAttachSpec,
    owner: TerminalAttachOwner,
  ): TerminalAttachResult
  terminalInput(attachId: string, data: string): TerminalInputResult
  terminalResize(attachId: string, cols: number, rows: number): TerminalResizeResult
  terminalSetGeometryActive(attachId: string, active: boolean): TerminalResizeResult
  terminalDetach(attachId: string): void
  terminalDetachAll(attachIds: readonly string[]): void
}

export interface RemoteControlTerminalDeps {
  internalAttachId?(): string
  onError(message: string): void
  timeoutMilliseconds?: number
  screenCharacterLimit?: number
}

export interface RemoteControlLiveTerminalAttachDto {
  attachId: string
  sessionId: string
}

export interface RemoteControlLiveTerminalInputDto {
  attachId: string
  accepted: true
  characterCount: number
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

export class RemoteControlTerminal implements RemoteControlTerminalPort {
  private static readonly timeoutMillisecondsConst = 5_000
  private static readonly screenCharacterLimitConst = 32_768

  private readonly internalAttachId: () => string
  private readonly timeoutMilliseconds: number
  private readonly screenCharacterLimit: number
  private readonly liveByOwner = new Map<string, Map<string, LiveTerminalAttachment>>()

  constructor(
    private readonly sessions: RemoteControlTerminalSessionPort,
    private readonly deps: RemoteControlTerminalDeps,
  ) {
    this.internalAttachId = deps.internalAttachId ?? randomUUID
    this.timeoutMilliseconds = deps.timeoutMilliseconds
      ?? RemoteControlTerminal.timeoutMillisecondsConst
    this.screenCharacterLimit = deps.screenCharacterLimit
      ?? RemoteControlTerminal.screenCharacterLimitConst
  }

  peek(
    sessionId: string,
    options: { cols?: number; rows?: number; timeoutMs?: number },
  ): Promise<RemoteControlStepResult<RemoteControlTerminalPeekDto>> {
    const size = options.cols === undefined || options.rows === undefined
      ? null
      : { cols: options.cols, rows: options.rows }
    return this.once(
      'peek',
      sessionId,
      size,
      options.timeoutMs,
      (_attachId, frame, finish) => {
        if (frame.type === 'terminal.snapshot') {
          const screen = frame.projection.screen.length <= this.screenCharacterLimit
            ? frame.projection.screen
            : frame.projection.screen.slice(-this.screenCharacterLimit)
          finish(RemoteControlTerminal.success({
            sessionId,
            snapshot: {
              type: 'terminal.snapshot',
              projection: {
                runtimeSessionId: frame.projection.runtimeSessionId,
                generation: frame.projection.generation,
                outputEpoch: frame.projection.outputEpoch,
                outputSeq: frame.projection.outputSeq,
                screen,
                screenTruncated: screen.length !== frame.projection.screen.length,
                cols: frame.projection.cols,
                rows: frame.projection.rows,
                alive: frame.projection.alive,
                lastOutputAt: frame.projection.lastOutputAt,
              },
            },
            terminalOutputUntrusted: true,
          }))
        } else if (frame.type === 'terminal.status') {
          if (frame.status === 'connecting' || frame.status === 'read-only')
            return
          else if (frame.status === 'lost')
            finish(RemoteControlTerminal.statusError(frame))
          else
            throw new Error(`Unknown terminal status: ${JSON.stringify(frame)}`)
        } else if (frame.type === 'terminal.attached'
          || frame.type === 'terminal.data'
          || frame.type === 'terminal.delta'
          || frame.type === 'terminal.resize')
          return
        else if (frame.type === 'terminal.exit')
          finish(RemoteControlTerminal.error(
            'operation-failed',
            'The terminal exited before its screen was available',
          ))
        else
          throw new Error(`Unknown terminal frame: ${JSON.stringify(frame)}`)
      },
    )
  }

  send(
    sessionId: string,
    text: string,
    options: { enter: boolean; timeoutMs?: number },
  ): Promise<RemoteControlStepResult<RemoteControlTerminalSendDto>> {
    return this.once(
      'send',
      sessionId,
      null,
      options.timeoutMs,
      (attachId, frame, finish) => {
        if (frame.type === 'terminal.attached') {
          if (!frame.writer) {
            finish(RemoteControlTerminal.error(
              'conflict',
              'The terminal attach is read-only',
            ))
            return
          }
          const input = this.sessions.terminalInput(
            attachId,
            options.enter ? `${text}\r` : text,
          )
          if (input.kind === 'sent')
            finish(RemoteControlTerminal.success({
              sessionId,
              accepted: true,
              characterCount: text.length,
              enter: options.enter,
            }))
          else if (input.kind === 'not-writer')
            finish(RemoteControlTerminal.error('conflict', 'The terminal attach is read-only'))
          else if (input.kind === 'unknown-attach')
            finish(RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared'))
          else
            throw new Error(`Unknown terminal input result: ${JSON.stringify(input)}`)
        } else if (frame.type === 'terminal.status') {
          if (frame.status === 'connecting')
            return
          else if (frame.status === 'read-only')
            finish(RemoteControlTerminal.error('conflict', 'The terminal attach is read-only'))
          else if (frame.status === 'lost')
            finish(RemoteControlTerminal.statusError(frame))
          else
            throw new Error(`Unknown terminal status: ${JSON.stringify(frame)}`)
        } else if (frame.type === 'terminal.snapshot'
          || frame.type === 'terminal.data'
          || frame.type === 'terminal.delta'
          || frame.type === 'terminal.resize')
          return
        else if (frame.type === 'terminal.exit')
          finish(RemoteControlTerminal.error('operation-failed', 'The terminal has exited'))
        else
          throw new Error(`Unknown terminal frame: ${JSON.stringify(frame)}`)
      },
    )
  }

  attachLive(
    ownerId: string,
    attachId: string,
    spec: TerminalAttachSpec,
    onFrame: (frame: TerminalFrame) => void,
  ): RemoteControlStepResult<RemoteControlLiveTerminalAttachDto> {
    const owned = this.liveByOwner.get(ownerId)
    if (owned?.has(attachId))
      return RemoteControlTerminal.error(
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
    const attached = this.sessions.terminalAttach(live.internalAttachId, spec, {
      source: 'remote',
      onFrame: (frame) => this.liveFrame(ownerId, attachId, live, frame, onFrame),
    })
    if (!attached.ok) {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.attachError(attached)
    }
    return RemoteControlTerminal.success({ attachId, sessionId: spec.sessionId })
  }

  inputLive(
    ownerId: string,
    attachId: string,
    data: string,
  ): RemoteControlStepResult<RemoteControlLiveTerminalInputDto> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const input = this.sessions.terminalInput(live.internalAttachId, data)
    if (input.kind === 'sent')
      return RemoteControlTerminal.success({
        attachId,
        accepted: true,
        characterCount: data.length,
      })
    else if (input.kind === 'not-writer')
      return RemoteControlTerminal.error('conflict', 'The terminal attach is read-only')
    else if (input.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal input result: ${JSON.stringify(input)}`)
  }

  resizeLive(
    ownerId: string,
    attachId: string,
    cols: number,
    rows: number,
  ): RemoteControlStepResult<RemoteControlLiveTerminalResizeDto> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const resized = this.sessions.terminalResize(live.internalAttachId, cols, rows)
    if (resized.kind === 'applied' || resized.kind === 'ignored')
      return RemoteControlTerminal.success({
        attachId,
        accepted: true,
        applied: resized.kind === 'applied',
      })
    else if (resized.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal resize result: ${JSON.stringify(resized)}`)
  }

  setLiveActive(
    ownerId: string,
    attachId: string,
    active: boolean,
  ): RemoteControlStepResult<RemoteControlLiveTerminalResizeDto> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const resized = this.sessions.terminalSetGeometryActive(live.internalAttachId, active)
    if (resized.kind === 'applied' || resized.kind === 'ignored')
      return RemoteControlTerminal.success({
        attachId,
        accepted: true,
        applied: resized.kind === 'applied',
      })
    else if (resized.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal resize result: ${JSON.stringify(resized)}`)
  }

  detachLive(ownerId: string, attachId: string): RemoteControlStepResult<{ attachId: string }> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    this.forgetLive(ownerId, attachId, live)
    this.sessions.terminalDetach(live.internalAttachId)
    return RemoteControlTerminal.success({ attachId })
  }

  detachOwner(ownerId: string): void {
    const owned = this.liveByOwner.get(ownerId)
    if (!owned) return
    this.liveByOwner.delete(ownerId)
    this.sessions.terminalDetachAll(
      [...owned.values()].map((live) => live.internalAttachId),
    )
  }

  private once<T>(
    kind: 'peek' | 'send',
    sessionId: string,
    size: TerminalAttachSpec['size'],
    timeoutMilliseconds: number | undefined,
    onFrame: (
      attachId: string,
      frame: TerminalFrame,
      finish: (result: RemoteControlStepResult<T>) => void,
    ) => void,
  ): Promise<RemoteControlStepResult<T>> {
    const attachId = `control-${kind}:${this.internalAttachId()}`
    return new Promise((resolve) => {
      let settled = false
      let attached = false
      let attachComplete = false
      let detachOwed = false
      const timer = setTimeout(() => finish(RemoteControlTerminal.error(
        'timeout',
        `The terminal ${kind} operation timed out`,
      )), timeoutMilliseconds ?? this.timeoutMilliseconds)
      const finish = (result: RemoteControlStepResult<T>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (attached)
          this.sessions.terminalDetach(attachId)
        else if (!attachComplete)
          detachOwed = true
        resolve(result)
      }
      const answer = this.sessions.terminalAttach(attachId, { sessionId, size }, {
        source: 'remote',
        onFrame: (frame) => {
          if (settled) return
          try {
            onFrame(attachId, frame, finish)
          } catch (error) {
            this.deps.onError(`Remote terminal ${kind} failed: ${ErrorText.of(error)}`)
            finish(RemoteControlTerminal.error(
              'operation-failed',
              `The terminal ${kind} operation failed`,
            ))
          }
        },
      })
      attachComplete = true
      if (answer.ok) {
        attached = true
        if (detachOwed) this.sessions.terminalDetach(attachId)
      } else finish(RemoteControlTerminal.attachError(answer))
    })
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
      this.sessions.terminalDetach(live.internalAttachId)
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
      return RemoteControlTerminal.error('unavailable', answer.detail)
    else if (answer.code === 'not-live' || answer.code === 'unknown-session')
      return RemoteControlTerminal.error('not-found', answer.detail)
    else
      throw new Error(`Unknown terminal attach refusal: ${JSON.stringify(answer)}`)
  }

  private static statusError<T>(
    frame: Extract<TerminalFrame, { type: 'terminal.status' }>,
  ): RemoteControlStepResult<T> {
    if (frame.status !== 'lost')
      throw new Error(`Terminal status is not lost: ${JSON.stringify(frame)}`)
    return frame.code === 'not-live' || frame.code === 'unknown-session'
      ? RemoteControlTerminal.error('not-found', frame.detail ?? 'The terminal was lost')
      : RemoteControlTerminal.error('unavailable', frame.detail ?? 'The terminal was lost')
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
