import { WebSocket } from 'ws'

import type { RemoteControlStepResult } from './remoteControlApi.types'
import type {
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
} from './remoteControlPeerApi.types'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import { RemoteControlPeerCodec } from './remoteControlPeerCodec'
import {
  RemoteControlPeerConnection,
  type RemoteControlPeerConnectionOptions,
} from './remoteControlPeerConnection'
import { RemoteControlPeerHandshakeError } from './core/remoteControlPeerHandshakeError'

export interface RemoteControlPeerClientOptions extends RemoteControlPeerConnectionOptions {
  connectTimeoutMilliseconds?: number
  socket?(url: string): WebSocket
  now?: () => number
}

export class RemoteControlPeerClient {
  private static readonly connectTimeoutMillisecondsConst = 10_000

  constructor(
    private readonly identity: RemoteControlPeerIdentity,
    private readonly sign: (payload: Buffer) => string,
    private readonly options?: RemoteControlPeerClientOptions,
  ) {}

  connect(
    profile: RemoteControlPeerProfile,
    signal?: AbortSignal,
  ): Promise<RemoteControlStepResult<RemoteControlPeerConnection>> {
    if (signal?.aborted)
      return Promise.resolve(RemoteControlPeerClient.error('unavailable', 'Remote connection cancelled'))
    return new Promise((resolve) => {
      const state = RemoteControlPeerCodec.createClientHello(
        this.identity,
        profile,
        this.sign,
        { now: this.options?.now?.() },
      )
      let socket: WebSocket
      try {
        socket = this.options?.socket?.(RemoteControlPeerClient.url(profile))
          ?? new WebSocket(RemoteControlPeerClient.url(profile), {
            handshakeTimeout: this.options?.connectTimeoutMilliseconds
              ?? RemoteControlPeerClient.connectTimeoutMillisecondsConst,
            maxPayload: RemoteControlPeerConst.maximumFrameBytes,
          })
      } catch {
        resolve(RemoteControlPeerClient.error('unavailable', 'Remote AppClientUI is unavailable'))
        return
      }
      let settled = false
      const finish = (result: RemoteControlStepResult<RemoteControlPeerConnection>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        socket.off('open', opened)
        socket.off('message', message)
        socket.off('close', closed)
        // Terminating a pending handshake can emit a late error after its promise has settled.
        socket.off('error', failed)
        socket.on('error', () => undefined)
        if (!result.ok) try { socket.terminate() } catch {}
        resolve(result)
      }
      const opened = (): void => {
        try { socket.send(JSON.stringify(state.hello)) }
        catch { finish(RemoteControlPeerClient.error('unavailable', 'Remote handshake could not start')) }
      }
      const message = (data: WebSocket.RawData, isBinary: boolean): void => {
        try {
          if (isBinary) throw new Error('Remote handshake returned a binary frame')
          const codec = RemoteControlPeerCodec.acceptServerHello(
            JSON.parse(data.toString()),
            state,
            this.options?.now?.(),
          )
          finish({
            ok: true,
            value: new RemoteControlPeerConnection(socket, codec, this.options),
          })
        } catch (error) {
          finish(RemoteControlPeerClient.handshakeError(error))
        }
      }
      const failed = (): void =>
        finish(RemoteControlPeerClient.error('unavailable', 'Remote AppClientUI is unavailable'))
      const closed = (): void =>
        finish(RemoteControlPeerClient.error('unavailable', 'Remote handshake was closed'))
      const aborted = (): void =>
        finish(RemoteControlPeerClient.error('unavailable', 'Remote connection cancelled'))
      socket.once('open', opened)
      socket.once('message', message)
      socket.once('error', failed)
      socket.once('close', closed)
      const timer = setTimeout(() =>
        finish(RemoteControlPeerClient.error('timeout', 'Remote handshake timed out')),
      this.options?.connectTimeoutMilliseconds
        ?? RemoteControlPeerClient.connectTimeoutMillisecondsConst)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  }

  private static url(profile: RemoteControlPeerProfile): string {
    const host = profile.endpoint.host.includes(':')
      ? `[${profile.endpoint.host.replace(/^\[|\]$/g, '')}]`
      : profile.endpoint.host
    return `ws://${host}:${profile.endpoint.port}/api/v3/peer`
  }

  private static handshakeError(
    error: unknown,
  ): RemoteControlStepResult<RemoteControlPeerConnection> {
    if (error instanceof RemoteControlPeerHandshakeError) {
      if (error.code === 'protocol-mismatch')
        return RemoteControlPeerClient.error('protocol-mismatch', 'Remote peer protocol does not match')
      else if (error.code === 'wrong-peer' || error.code === 'unauthorized')
        return RemoteControlPeerClient.error('forbidden', 'Remote peer identity was refused')
      else if (error.code === 'replay' || error.code === 'invalid-handshake')
        return RemoteControlPeerClient.error('operation-failed', 'Remote peer handshake was invalid')
      else
        throw new Error(`Unknown remote peer handshake error: ${JSON.stringify(error.code)}`)
    }
    return RemoteControlPeerClient.error('operation-failed', 'Remote peer handshake failed')
  }

  private static error(
    code: 'protocol-mismatch' | 'forbidden' | 'unavailable' | 'timeout' | 'operation-failed',
    detail: string,
  ): RemoteControlStepResult<never> {
    return { ok: false, error: { code, detail } }
  }
}
