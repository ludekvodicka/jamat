import { createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'

import type {
  RemoteControlPeerCapability,
  RemoteControlPeerClientHello,
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
  RemoteControlPeerServerHello,
} from './remoteControlPeerApi.types'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import { RemoteControlPeerCipher } from './core/remoteControlPeerCipher'
import { RemoteControlPeerHandshakeError } from './core/remoteControlPeerHandshakeError'
import {
  RemoteControlPeerKeys,
  type RemoteControlPeerEphemeralKeyPair,
} from './remoteControlPeerKeys'
import { RemoteControlPairing } from './remoteControlPairing'
import { JsonShape } from '../shared/jsonShape'

export interface RemoteControlPeerClientHandshakeState {
  hello: RemoteControlPeerClientHello
  ephemeral: RemoteControlPeerEphemeralKeyPair
  profile: RemoteControlPeerProfile
}

export interface RemoteControlPeerCodecResult {
  connectionId: string
  remoteIdentity: RemoteControlPeerIdentity
  capabilities: readonly RemoteControlPeerCapability[]
  outbound: RemoteControlPeerCipher
  inbound: RemoteControlPeerCipher
}

export interface RemoteControlPeerServerCodecResult extends RemoteControlPeerCodecResult {
  hello: RemoteControlPeerServerHello
}

export interface RemoteControlPeerServerHandshakeDeps {
  identity: RemoteControlPeerIdentity
  trustedInbound(remoteComputerId: string, remoteEndpointId: string): RemoteControlPeerIdentity | null
  sign(payload: Buffer): string
  acceptNonce(remoteComputerId: string, nonce: string, sentAt: number): boolean
  allowedCapabilities?: readonly RemoteControlPeerCapability[]
  now?: number
}

export class RemoteControlPeerCodec {
  /**
   * How far apart the two clocks may be for a hello to count as fresh. Public because the nonce
   * store on the other side of the handshake has to remember a nonce for exactly as long as the
   * hello carrying it could still be accepted; the two numbers are one decision.
   */
  static readonly maximumClockSkewMillisecondsConst = 30_000
  /**
   * How long a capability list may be, and how long one name in it may be. Both are read bounds
   * rather than a statement about this build's own list, which is the shorter of the two by
   * definition: a peer may name more than this side knows, and neither the list nor a name in it
   * may be unbounded because both arrive from another machine.
   */
  private static readonly capabilitiesBoundConst = 128
  private static readonly capabilityLengthConst = 128

  static createClientHello(
    identity: RemoteControlPeerIdentity,
    profile: RemoteControlPeerProfile,
    sign: (payload: Buffer) => string,
    options?: {
      now?: number
      connectionId?: string
      nonce?: string
      ephemeral?: RemoteControlPeerEphemeralKeyPair
      /**
       * `string[]` rather than the narrow union, because this is exactly what a NEWER build does to
       * an older one: it asks for a name the other side has no gate for. Tests stage that here.
       */
      capabilities?: readonly string[]
    },
  ): RemoteControlPeerClientHandshakeState {
    RemoteControlPeerCodec.assertIdentity(identity)
    RemoteControlPeerCodec.assertProfile(profile)
    const ephemeral = options?.ephemeral ?? RemoteControlPeerKeys.generateEphemeralKeyPair()
    const unsigned: Omit<RemoteControlPeerClientHello, 'signature'> = {
      protocol: RemoteControlPeerConst.protocol,
      type: 'client-hello',
      connectionId: options?.connectionId ?? randomUUID(),
      sentAt: options?.now ?? Date.now(),
      nonce: options?.nonce ?? randomBytes(32).toString('base64url'),
      identity: structuredClone(identity),
      expectedRemoteComputerId: profile.remoteComputerId,
      expectedRemoteEndpointId: profile.remoteEndpointId,
      ephemeralPublicKey: ephemeral.publicKey,
      capabilities: [...(options?.capabilities ?? RemoteControlPeerConst.capabilities)],
    }
    RemoteControlPeerCodec.assertClientHello(unsigned)
    return {
      hello: { ...unsigned, signature: sign(RemoteControlPeerCodec.clientPayload(unsigned)) },
      ephemeral,
      profile: structuredClone(profile),
    }
  }

  static acceptClientHello(
    input: unknown,
    deps: RemoteControlPeerServerHandshakeDeps,
  ): RemoteControlPeerServerCodecResult {
    const hello = RemoteControlPeerCodec.clientHello(input)
    const now = deps.now ?? Date.now()
    RemoteControlPeerCodec.assertFresh(hello.sentAt, now)
    RemoteControlPeerCodec.assertIdentity(deps.identity)
    if (hello.expectedRemoteComputerId !== deps.identity.remoteComputerId
      || hello.expectedRemoteEndpointId !== deps.identity.remoteEndpointId)
      throw new RemoteControlPeerHandshakeError('wrong-peer', 'Client expected another remote peer')
    const trusted = deps.trustedInbound(
      hello.identity.remoteComputerId,
      hello.identity.remoteEndpointId,
    )
    if (trusted === null) {
      // Nobody has pinned this caller. `identity()` already proved the fingerprint matches the key
      // in the hello, so verifying the hello against that same key is proof of possession, and only
      // then is the refusal worth naming a claimant to the listener.
      const selfSigned = RemoteControlPeerKeys.verify(
        hello.identity.signing.publicKey,
        RemoteControlPeerCodec.clientPayload(hello),
        hello.signature,
      )
      throw new RemoteControlPeerHandshakeError(
        'unauthorized',
        'Client identity is not paired',
        selfSigned ? structuredClone(hello.identity) : undefined,
      )
    }
    if (!RemoteControlPeerCodec.samePinnedPeer(trusted, hello.identity))
      // A known id under a DIFFERENT key carries no claimant on purpose: it is an impersonation
      // attempt, and it must not be able to raise a question about itself.
      throw new RemoteControlPeerHandshakeError('unauthorized', 'Client identity is not paired')
    if (!RemoteControlPeerKeys.verify(
      trusted.signing.publicKey,
      RemoteControlPeerCodec.clientPayload(hello),
      hello.signature,
    ))
      throw new RemoteControlPeerHandshakeError('unauthorized', 'Client signature is invalid')
    if (!deps.acceptNonce(hello.identity.remoteComputerId, hello.nonce, hello.sentAt))
      throw new RemoteControlPeerHandshakeError('replay', 'Client hello was already used')

    const ephemeral = RemoteControlPeerKeys.generateEphemeralKeyPair()
    const allowed = deps.allowedCapabilities ?? RemoteControlPeerConst.capabilities
    const capabilities = RemoteControlPeerCodec.intersection(hello.capabilities, allowed)
    const clientHelloHash = RemoteControlPeerCodec.hash(hello)
    const unsigned: Omit<RemoteControlPeerServerHello, 'signature'> = {
      protocol: RemoteControlPeerConst.protocol,
      type: 'server-hello',
      connectionId: hello.connectionId,
      sentAt: now,
      nonce: randomBytes(32).toString('base64url'),
      identity: structuredClone(deps.identity),
      ephemeralPublicKey: ephemeral.publicKey,
      capabilities,
      clientHelloHash,
    }
    RemoteControlPeerCodec.assertServerHello(unsigned)
    const serverHello = {
      ...unsigned,
      signature: deps.sign(RemoteControlPeerCodec.serverPayload(unsigned)),
    }
    return {
      ...RemoteControlPeerCodec.derive(
        'server',
        hello,
        serverHello,
        ephemeral,
        hello.ephemeralPublicKey,
      ),
      hello: serverHello,
      remoteIdentity: structuredClone(hello.identity),
      capabilities,
    }
  }

  static acceptServerHello(
    input: unknown,
    state: RemoteControlPeerClientHandshakeState,
    now = Date.now(),
  ): RemoteControlPeerCodecResult {
    const hello = RemoteControlPeerCodec.serverHello(input)
    RemoteControlPeerCodec.assertFresh(hello.sentAt, now)
    if (hello.connectionId !== state.hello.connectionId
      || hello.clientHelloHash !== RemoteControlPeerCodec.hash(state.hello))
      throw new RemoteControlPeerHandshakeError(
        'invalid-handshake',
        'Server hello does not match the client hello',
      )
    if (!RemoteControlPeerCodec.profileMatches(state.profile, hello.identity))
      throw new RemoteControlPeerHandshakeError('wrong-peer', 'Server identity does not match pairing')
    if (!hello.capabilities.every((capability) => state.hello.capabilities.includes(capability)))
      throw new RemoteControlPeerHandshakeError(
        'invalid-handshake',
        'Server selected an unrequested capability',
      )
    if (!RemoteControlPeerKeys.verify(
      state.profile.pinnedIdentity.publicKey,
      RemoteControlPeerCodec.serverPayload(hello),
      hello.signature,
    ))
      throw new RemoteControlPeerHandshakeError('unauthorized', 'Server signature is invalid')
    return {
      ...RemoteControlPeerCodec.derive(
        'client',
        state.hello,
        hello,
        state.ephemeral,
        hello.ephemeralPublicKey,
      ),
      remoteIdentity: structuredClone(hello.identity),
      // Through the intersection rather than copied: the check above proves the server selected
      // nothing this client did not request, and this is what makes the narrow type true of it.
      capabilities: RemoteControlPeerCodec.intersection(
        hello.capabilities,
        RemoteControlPeerConst.capabilities,
      ),
    }
  }

  private static derive(
    role: 'client' | 'server',
    clientHello: RemoteControlPeerClientHello,
    serverHello: RemoteControlPeerServerHello,
    localEphemeral: RemoteControlPeerEphemeralKeyPair,
    remoteEphemeralPublicKey: string,
  ): Omit<RemoteControlPeerCodecResult, 'remoteIdentity' | 'capabilities'> {
    const shared = RemoteControlPeerKeys.sharedSecret(
      localEphemeral.privateKey,
      remoteEphemeralPublicKey,
    )
    const salt = createHash('sha256')
      .update(JSON.stringify([clientHello, serverHello]))
      .digest()
    const material = Buffer.from(hkdfSync(
      'sha256',
      shared,
      salt,
      Buffer.from(RemoteControlPeerConst.protocol),
      72,
    ))
    const clientKey = material.subarray(0, 32)
    const serverKey = material.subarray(32, 64)
    const clientNonce = material.subarray(64, 68)
    const serverNonce = material.subarray(68, 72)
    const clientCipher = new RemoteControlPeerCipher(
      clientHello.connectionId,
      'client-to-server',
      clientKey,
      clientNonce,
    )
    const serverCipher = new RemoteControlPeerCipher(
      clientHello.connectionId,
      'server-to-client',
      serverKey,
      serverNonce,
    )
    return role === 'client'
      ? { connectionId: clientHello.connectionId, outbound: clientCipher, inbound: serverCipher }
      : { connectionId: clientHello.connectionId, outbound: serverCipher, inbound: clientCipher }
  }

  private static clientHello(input: unknown): RemoteControlPeerClientHello {
    if (!JsonShape.isRecord(input))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Client hello is not an object')
    if (input.protocol !== RemoteControlPeerConst.protocol)
      throw new RemoteControlPeerHandshakeError('protocol-mismatch', 'Peer protocol does not match')
    RemoteControlPeerCodec.assertClientHello(input)
    if (!RemoteControlPeerCodec.encoded(input.signature, 4096))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Client signature is invalid')
    return input as unknown as RemoteControlPeerClientHello
  }

  private static serverHello(input: unknown): RemoteControlPeerServerHello {
    if (!JsonShape.isRecord(input))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Server hello is not an object')
    if (input.protocol !== RemoteControlPeerConst.protocol)
      throw new RemoteControlPeerHandshakeError('protocol-mismatch', 'Peer protocol does not match')
    RemoteControlPeerCodec.assertServerHello(input)
    if (!RemoteControlPeerCodec.encoded(input.signature, 4096))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Server signature is invalid')
    return input as unknown as RemoteControlPeerServerHello
  }

  private static assertClientHello(input: Record<string, unknown>): void {
    if (input.protocol !== RemoteControlPeerConst.protocol
      || input.type !== 'client-hello'
      || !RemoteControlPeerCodec.text(input.connectionId, 512)
      || !RemoteControlPeerCodec.timestamp(input.sentAt)
      || !RemoteControlPeerCodec.encoded(input.nonce, 512)
      || !RemoteControlPeerCodec.identity(input.identity)
      || !RemoteControlPeerCodec.text(input.expectedRemoteComputerId, 512)
      || !RemoteControlPeerCodec.text(input.expectedRemoteEndpointId, 512)
      || !RemoteControlPeerCodec.encoded(input.ephemeralPublicKey, 4096)
      || !RemoteControlPeerCodec.capabilities(input.capabilities))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Client hello is invalid')
  }

  private static assertServerHello(input: Record<string, unknown>): void {
    if (input.protocol !== RemoteControlPeerConst.protocol
      || input.type !== 'server-hello'
      || !RemoteControlPeerCodec.text(input.connectionId, 512)
      || !RemoteControlPeerCodec.timestamp(input.sentAt)
      || !RemoteControlPeerCodec.encoded(input.nonce, 512)
      || !RemoteControlPeerCodec.identity(input.identity)
      || !RemoteControlPeerCodec.encoded(input.ephemeralPublicKey, 4096)
      || !RemoteControlPeerCodec.capabilities(input.capabilities)
      || !RemoteControlPeerCodec.encoded(input.clientHelloHash, 512))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Server hello is invalid')
  }

  private static assertIdentity(identity: RemoteControlPeerIdentity): void {
    if (!RemoteControlPeerCodec.identity(identity))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Peer identity is invalid')
  }

  private static assertProfile(profile: RemoteControlPeerProfile): void {
    try { RemoteControlPairing.assertProfile(profile) }
    catch {
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Peer profile is invalid')
    }
  }

  private static clientPayload(
    hello: Omit<RemoteControlPeerClientHello, 'signature'> | RemoteControlPeerClientHello,
  ): Buffer {
    return Buffer.from(JSON.stringify([
      hello.protocol,
      hello.type,
      hello.connectionId,
      hello.sentAt,
      hello.nonce,
      RemoteControlPeerCodec.identityTuple(hello.identity),
      hello.expectedRemoteComputerId,
      hello.expectedRemoteEndpointId,
      hello.ephemeralPublicKey,
      hello.capabilities,
    ]))
  }

  private static serverPayload(
    hello: Omit<RemoteControlPeerServerHello, 'signature'> | RemoteControlPeerServerHello,
  ): Buffer {
    return Buffer.from(JSON.stringify([
      hello.protocol,
      hello.type,
      hello.connectionId,
      hello.sentAt,
      hello.nonce,
      RemoteControlPeerCodec.identityTuple(hello.identity),
      hello.ephemeralPublicKey,
      hello.capabilities,
      hello.clientHelloHash,
    ]))
  }

  private static identityTuple(identity: RemoteControlPeerIdentity): readonly unknown[] {
    return [
      identity.remoteComputerId,
      identity.remoteEndpointId,
      identity.configIdentity,
      identity.runtimeChannel,
      identity.displayName,
      identity.signing.algorithm,
      identity.signing.publicKey,
      identity.signing.fingerprint,
    ]
  }

  private static identity(value: unknown): value is RemoteControlPeerIdentity {
    if (!JsonShape.isRecord(value)
      || !RemoteControlPeerCodec.text(value.remoteComputerId, 512)
      || !RemoteControlPeerCodec.text(value.remoteEndpointId, 512)
      || !RemoteControlPeerCodec.text(value.configIdentity, 512)
      || (value.runtimeChannel !== 'development' && value.runtimeChannel !== 'production')
      || !RemoteControlPeerCodec.text(value.displayName, 256)
      || /[\r\n]/.test(value.displayName)
      || !JsonShape.isRecord(value.signing)
      || value.signing.algorithm !== RemoteControlPeerConst.signingAlgorithm
      || !RemoteControlPeerCodec.encoded(value.signing.publicKey, 4096)
      || !RemoteControlPeerCodec.encoded(value.signing.fingerprint, 512))
      return false
    return RemoteControlPeerKeys.validatePublicKey(value.signing.publicKey)
      && RemoteControlPeerKeys.fingerprint(value.signing.publicKey) === value.signing.fingerprint
  }

  private static profileMatches(
    profile: RemoteControlPeerProfile,
    identity: RemoteControlPeerIdentity,
  ): boolean {
    return profile.remoteComputerId === identity.remoteComputerId
      && profile.remoteEndpointId === identity.remoteEndpointId
      && profile.configIdentity === identity.configIdentity
      && profile.runtimeChannel === identity.runtimeChannel
      && profile.pinnedIdentity.algorithm === identity.signing.algorithm
      && profile.pinnedIdentity.publicKey === identity.signing.publicKey
      && profile.pinnedIdentity.fingerprint === identity.signing.fingerprint
      && RemoteControlPeerCodec.identity(identity)
  }

  private static samePinnedPeer(
    trusted: RemoteControlPeerIdentity,
    claimed: RemoteControlPeerIdentity,
  ): boolean {
    return trusted.remoteComputerId === claimed.remoteComputerId
      && trusted.remoteEndpointId === claimed.remoteEndpointId
      && trusted.configIdentity === claimed.configIdentity
      && trusted.runtimeChannel === claimed.runtimeChannel
      && trusted.signing.publicKey === claimed.signing.publicKey
      && trusted.signing.fingerprint === claimed.signing.fingerprint
  }

  /**
   * Shape and a bound, and deliberately NOT membership of this build's list.
   *
   * A name this build has never heard of used to refuse the whole hello, so the first capability
   * ever added would have broken every connection to a build that shipped before it - no
   * degradation, no missing feature, no connection at all. An unknown name is dropped by the
   * intersection instead, which is where a capability becomes a grant. This cannot repair builds
   * already out there; from here on, version skew costs a capability rather than the handshake.
   */
  private static capabilities(value: unknown): value is readonly string[] {
    if (!Array.isArray(value) || value.length > RemoteControlPeerCodec.capabilitiesBoundConst)
      return false
    const seen = new Set<string>()
    for (const capability of value) {
      if (!RemoteControlPeerCodec.text(capability, RemoteControlPeerCodec.capabilityLengthConst)
        || seen.has(capability))
        return false
      seen.add(capability)
    }
    return true
  }

  /** What both sides can name AND both sides allow. Anything else is not a grant. */
  private static intersection(
    requested: readonly string[],
    allowed: readonly RemoteControlPeerCapability[],
  ): readonly RemoteControlPeerCapability[] {
    return RemoteControlPeerConst.capabilities.filter((capability) =>
      requested.includes(capability) && allowed.includes(capability))
  }

  private static assertFresh(sentAt: number, now: number): void {
    if (Math.abs(now - sentAt) > RemoteControlPeerCodec.maximumClockSkewMillisecondsConst)
      throw new RemoteControlPeerHandshakeError('replay', 'Peer hello is outside the allowed clock window')
  }

  private static hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('base64url')
  }


  private static text(value: unknown, maximum: number): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
  }

  private static timestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  }

  private static encoded(value: unknown, maximum: number): value is string {
    return typeof value === 'string'
      && value.length >= 16
      && value.length <= maximum
      && /^[A-Za-z0-9_-]+$/.test(value)
  }
}
