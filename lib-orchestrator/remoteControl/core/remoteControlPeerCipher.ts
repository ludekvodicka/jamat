import { createCipheriv, createDecipheriv } from 'node:crypto'

import type {
  RemoteControlPeerEncryptedMessage,
  RemoteControlPeerInboundMessage,
  RemoteControlPeerSealedFrame,
} from '../remoteControlPeerApi.types'
import { RemoteControlPeerConst } from '../remoteControlPeerProtocol'
import { JsonShape } from '../../shared/jsonShape'

export class RemoteControlPeerCipher {
  private sequence = 0

  constructor(
    private readonly connectionId: string,
    private readonly direction: 'client-to-server' | 'server-to-client',
    private readonly key: Buffer,
    private readonly noncePrefix: Buffer,
  ) {
    if (key.length !== 32 || noncePrefix.length !== 4)
      throw new Error('Remote peer cipher key material is invalid')
  }

  seal(message: RemoteControlPeerEncryptedMessage): RemoteControlPeerSealedFrame {
    const plaintext = Buffer.from(JSON.stringify(message), 'utf8')
    if (plaintext.length > RemoteControlPeerConst.maximumPlaintextBytes)
      throw new Error('Remote peer message exceeds the plaintext limit')
    const sequence = this.sequence
    if (!Number.isSafeInteger(sequence)) throw new Error('Remote peer sequence is exhausted')
    const cipher = createCipheriv('aes-256-gcm', this.key, this.iv(sequence))
    cipher.setAAD(this.aad(sequence))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    this.sequence += 1
    return {
      protocol: RemoteControlPeerConst.protocol,
      type: 'sealed',
      connectionId: this.connectionId,
      sequence,
      ciphertext: ciphertext.toString('base64url'),
      authenticationTag: cipher.getAuthTag().toString('base64url'),
    }
  }

  /**
   * Note the return type: what comes out is an envelope whose payload nobody has read yet. The
   * check below can only tell that a payload IS something; saying it is a validated request or a
   * validated response would be a promise this class cannot keep.
   */
  open(input: unknown): RemoteControlPeerInboundMessage {
    if (!RemoteControlPeerCipher.frame(input)
      || input.connectionId !== this.connectionId
      || input.sequence !== this.sequence)
      throw new Error('Remote peer frame is invalid, replayed or out of order')
    const ciphertext = Buffer.from(input.ciphertext, 'base64url')
    if (ciphertext.length > RemoteControlPeerConst.maximumPlaintextBytes)
      throw new Error('Remote peer frame exceeds the plaintext limit')
    const decipher = createDecipheriv('aes-256-gcm', this.key, this.iv(input.sequence))
    decipher.setAAD(this.aad(input.sequence))
    decipher.setAuthTag(Buffer.from(input.authenticationTag, 'base64url'))
    let plaintext: Buffer
    try { plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]) }
    catch { throw new Error('Remote peer frame authentication failed') }
    let parsed: unknown
    try { parsed = JSON.parse(plaintext.toString('utf8')) }
    catch { throw new Error('Remote peer frame plaintext is not JSON') }
    if (!RemoteControlPeerCipher.message(parsed))
      throw new Error('Remote peer frame carries an invalid message')
    this.sequence += 1
    return parsed
  }

  private iv(sequence: number): Buffer {
    const value = Buffer.alloc(12)
    this.noncePrefix.copy(value, 0)
    value.writeBigUInt64BE(BigInt(sequence), 4)
    return value
  }

  private aad(sequence: number): Buffer {
    return Buffer.from(JSON.stringify([
      RemoteControlPeerConst.protocol,
      this.connectionId,
      this.direction,
      sequence,
    ]))
  }

  private static frame(value: unknown): value is RemoteControlPeerSealedFrame {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const frame = value as Partial<RemoteControlPeerSealedFrame>
    return frame.protocol === RemoteControlPeerConst.protocol
      && frame.type === 'sealed'
      && typeof frame.connectionId === 'string'
      && frame.connectionId.length > 0
      && Number.isSafeInteger(frame.sequence)
      && (frame.sequence as number) >= 0
      && RemoteControlPeerCipher.encoded(frame.ciphertext)
      && RemoteControlPeerCipher.encoded(frame.authenticationTag)
  }

  private static message(value: unknown): value is RemoteControlPeerInboundMessage {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const message = value as Record<string, unknown>
    if (message.type === 'control-request') return JsonShape.isRecord(message.request)
    else if (message.type === 'control-response')
      return JsonShape.isRecord(message.response)
    else if (message.type === 'socket-request') return JsonShape.isRecord(message.request)
    else if (message.type === 'socket-response')
      return JsonShape.isRecord(message.response)
    else if (message.type === 'heartbeat-ping' || message.type === 'heartbeat-pong')
      return Number.isSafeInteger(message.sentAt) && (message.sentAt as number) >= 0
    else return false
  }


  private static encoded(value: unknown): value is string {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= RemoteControlPeerConst.maximumFrameBytes
      && /^[A-Za-z0-9_-]+$/.test(value)
  }
}
