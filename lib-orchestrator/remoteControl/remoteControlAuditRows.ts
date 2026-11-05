import type { RemoteControlError, RemoteControlLocalResponse, RemoteControlResponse, RemoteControlSocketRequest, RemoteControlSocketResponse } from './remoteControlApi.types'
import { JsonShape } from '../shared/jsonShape'

export interface RemoteControlAuditCaller {
  callerId: string
  callerKind: 'local-cli' | 'remote-peer'
}

export interface RemoteControlAuditEntry extends RemoteControlAuditCaller {
  at: number
  transport: 'http' | 'http-local' | 'http-remote' | 'peer-control' | 'websocket' | 'peer-socket'
  requestId: string | null
  operation: string | null
  operationId: string | null
  target: Record<string, unknown> | null
  ok: boolean
  errorCode?: RemoteControlError['code']
}

export interface RemoteControlPeerAudit {
  socket(transport: 'websocket' | 'peer-socket', request: RemoteControlSocketRequest | null,
    response: Extract<RemoteControlSocketResponse, { type: 'response' }>, caller: RemoteControlAuditCaller): void
  peerControl(request: unknown, response: RemoteControlResponse, caller: RemoteControlAuditCaller): void
}

export class RemoteControlAuditRows {
  static socket(at: number, transport: 'websocket' | 'peer-socket', request: RemoteControlSocketRequest | null,
    response: Extract<RemoteControlSocketResponse, { type: 'response' }>, caller: RemoteControlAuditCaller): RemoteControlAuditEntry {
    return { at, transport, ...caller, requestId: response.requestId, operation: response.operation,
      operationId: response.operationId, target: request === null ? null : RemoteControlAuditRows.socketTarget(request),
      ok: response.ok, ...(response.ok ? {} : { errorCode: response.error.code }) }
  }

  static control(at: number, transport: 'http' | 'http-local' | 'http-remote' | 'peer-control',
    request: unknown, response: RemoteControlResponse | RemoteControlLocalResponse, caller: RemoteControlAuditCaller,
    targetPrefix?: Record<string, unknown>): RemoteControlAuditEntry {
    const target = RemoteControlAuditRows.httpTarget(request, response)
    return { at, transport, ...caller, requestId: response.requestId, operation: response.operation,
      operationId: response.operationId, target: targetPrefix === undefined && target === null ? null : { ...targetPrefix, ...target },
      ok: response.ok, ...(response.ok ? {} : { errorCode: response.error.code }) }
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
    else if (request.operation === 'terminal.pasteImage')
      return { attachId: request.attachId, base64Length: request.data.length }
    else if (request.operation === 'terminal.pasteFile')
      return { attachId: request.attachId, uploadId: request.uploadId, size: request.size, offset: request.offset }
    else
      throw new Error(`Unknown socket audit operation: ${JSON.stringify(request)}`)
  }

}
