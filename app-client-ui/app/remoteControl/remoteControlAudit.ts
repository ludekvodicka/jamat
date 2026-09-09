import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  RemoteControlLocalResponse,
  RemoteControlResponse,
  RemoteControlSocketRequest,
  RemoteControlSocketResponse,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { ErrorText } from '../../shared/errorText'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

export interface RemoteControlAuditCaller {
  callerId: string
  callerKind: 'local-cli' | 'remote-peer'
}

export class RemoteControlAudit {
  /** One generation kept beside the live file. Two files, bounded, is what a log like this needs. */
  private static readonly rotateBytesConst = 8_388_608
  private static readonly flushDelayMillisecondsConst = 50
  private readonly pending: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private bytes: number | null = null

  constructor(
    private readonly file: string,
    private readonly onError: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  http(
    request: unknown,
    response: RemoteControlResponse,
    caller: RemoteControlAuditCaller,
  ): void {
    this.control('http', request, response, caller)
  }

  localHttp(
    request: unknown,
    response: RemoteControlLocalResponse,
    caller: RemoteControlAuditCaller,
  ): void {
    this.control('http-local', request, response, caller)
  }

  remoteHttp(
    request: unknown,
    response: RemoteControlResponse,
    caller: RemoteControlAuditCaller,
    remoteEndpointId: string,
  ): void {
    this.control('http-remote', request, response, caller, { remoteEndpointId })
  }

  /**
   * One row builder for both socket transports, and `request: null` for a request that never parsed
   * - which still happened, and used to leave no trace at all, so the way to stay out of this file
   * was to send something malformed.
   */
  socket(
    transport: 'websocket' | 'peer-socket',
    request: RemoteControlSocketRequest | null,
    response: Extract<RemoteControlSocketResponse, { type: 'response' }>,
    caller: RemoteControlAuditCaller,
  ): void {
    this.write({
      at: this.now(),
      transport,
      ...caller,
      requestId: response.requestId,
      operation: response.operation,
      operationId: response.operationId,
      target: request === null ? null : RemoteControlAudit.socketTarget(request),
      ok: response.ok,
      ...(response.ok ? {} : { errorCode: response.error.code }),
    })
  }

  peerControl(
    request: unknown,
    response: RemoteControlResponse,
    caller: RemoteControlAuditCaller,
  ): void {
    this.control('peer-control', request, response, caller)
  }

  private control(
    transport: 'http' | 'http-local' | 'http-remote' | 'peer-control',
    request: unknown,
    response: RemoteControlResponse | RemoteControlLocalResponse,
    caller: RemoteControlAuditCaller,
    targetPrefix?: Record<string, unknown>,
  ): void {
    const target = RemoteControlAudit.httpTarget(request, response)
    this.write({
      at: this.now(),
      transport,
      ...caller,
      requestId: response.requestId,
      operation: response.operation,
      operationId: response.operationId,
      target: targetPrefix === undefined && target === null
        ? null
        : { ...targetPrefix, ...target },
      ok: response.ok,
      ...(response.ok ? {} : { errorCode: response.error.code }),
    })
  }

  /**
   * Everything queued, on disk before this returns. For a stop, where there is no next tick left to
   * carry the batch.
   */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.appendPending()
  }

  /**
   * Queued, not written. `terminal.input` audits one row per KEYSTROKE, and each row used to be an
   * `appendFileSync` on the Electron main thread - the one that also draws the window. The rows
   * still leave in order and within 50 ms; a stop flushes what is left by hand.
   */
  private write(record: Record<string, unknown>): void {
    this.pending.push(JSON.stringify(record) + '\n')
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.appendPending()
    }, RemoteControlAudit.flushDelayMillisecondsConst)
    this.flushTimer.unref?.()
  }

  private appendPending(): void {
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0).join('')
    const size = Buffer.byteLength(batch)
    try {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      this.rotate(size)
      appendFileSync(this.file, batch, { encoding: 'utf8', mode: 0o600 })
      this.bytes = (this.bytes ?? 0) + size
    } catch (error) {
      try {
        this.onError(`Remote control audit write failed: ${ErrorText.of(error)}`)
      } catch {}
    }
  }

  /**
   * The size is carried in memory, so an ordinary row costs no stat. This file has TWO writers - the
   * local server and the peer registry each hold one of these - so the moment it looks full the real
   * size is read before anything is moved, or one of them would rotate what the other just rotated.
   */
  private rotate(incoming: number): void {
    if (this.bytes === null) this.bytes = RemoteControlAudit.sizeOf(this.file)
    if (this.bytes + incoming <= RemoteControlAudit.rotateBytesConst) return
    this.bytes = RemoteControlAudit.sizeOf(this.file)
    if (this.bytes + incoming <= RemoteControlAudit.rotateBytesConst) return
    renameSync(this.file, `${this.file}.1`)
    this.bytes = 0
  }

  private static sizeOf(file: string): number {
    return existsSync(file) ? statSync(file).size : 0
  }

  private static httpTarget(
    request: unknown,
    response: RemoteControlResponse | RemoteControlLocalResponse,
  ): Record<string, unknown> | null {
    const responseValue = response.ok ? JsonShape.record(response.value) : null
    if (response.operation === 'sessions.transcript')
      return typeof responseValue?.sessionId === 'string'
        ? { sessionId: responseValue.sessionId }
        : null
    const input = JsonShape.record(request)
    const body = JsonShape.record(input?.body)
    const selector = JsonShape.record(body?.session)
    const target: Record<string, unknown> = {}
    if (typeof selector?.sessionId === 'string') target.sessionId = selector.sessionId
    else if (typeof selector?.number === 'string') target.sessionNumber = selector.number
    if (typeof body?.panelId === 'string') target.panelId = body.panelId
    const bundle = JsonShape.record(body?.bundle)
    const identity = JsonShape.record(bundle?.identity)
    if (typeof identity?.remoteEndpointId === 'string')
      target.remoteEndpointId = identity.remoteEndpointId
    if (response.operation === 'terminal.send' && typeof body?.text === 'string')
      target.characterCount = body.text.length
    const value = responseValue
    if (response.operation === 'tabs.openFile' && typeof value?.path === 'string')
      target.path = value.path
    const session = JsonShape.record(value?.session)
    if (typeof session?.sessionId === 'string') target.createdSessionId = session.sessionId
    return Object.keys(target).length === 0 ? null : target
  }

  private static socketTarget(request: RemoteControlSocketRequest): Record<string, unknown> | null {
    if (request.operation === 'events.subscribe') return null
    else if (request.operation === 'terminal.attach')
      return { attachId: request.attachId, sessionId: request.sessionId }
    else if (request.operation === 'terminal.input')
      return { attachId: request.attachId, characterCount: request.data.length }
    else if (request.operation === 'terminal.resize')
      return { attachId: request.attachId, cols: request.cols, rows: request.rows }
    else if (request.operation === 'terminal.active')
      return { attachId: request.attachId, active: request.active }
    else if (request.operation === 'terminal.detach')
      return { attachId: request.attachId }
    else
      throw new Error(`Unknown socket audit operation: ${JSON.stringify(request)}`)
  }

}
