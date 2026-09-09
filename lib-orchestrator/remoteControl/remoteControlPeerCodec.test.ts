import { describe, expect, it } from 'vitest'

import type {
  RemoteControlPeerClientHello,
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
} from './remoteControlPeerApi.types'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import { RemoteControlPeerCodec } from './remoteControlPeerCodec'
import { RemoteControlPeerHandshakeError } from './core/remoteControlPeerHandshakeError'
import {
  RemoteControlPeerKeys,
  type RemoteControlPeerSigningKeyPair,
} from './remoteControlPeerKeys'

describe('lib-orchestrator/remoteControl/remoteControlPeerCodec', () => {
  it('mutually authenticates, derives opposite ciphers and carries only sealed messages', () => {
    const harness = new RemoteControlPeerCodecTest()
    const connected = harness.connect()
    const request = {
      type: 'control-request' as const,
      request: {
        protocol: 'appjamat-v3-control.v1' as const,
        requestId: 'request-1',
        operation: 'system.status' as const,
        body: {},
      },
    }
    const requestFrame = connected.client.outbound.seal(request)
    expect(requestFrame).not.toHaveProperty('request')
    expect(connected.server.inbound.open(requestFrame)).toEqual(request)

    const response = { type: 'heartbeat-pong' as const, sentAt: RemoteControlPeerCodecTest.now }
    const responseFrame = connected.server.outbound.seal(response)
    expect(connected.client.inbound.open(responseFrame)).toEqual(response)
    expect(connected.client.remoteIdentity).toEqual(harness.serverIdentity)
    expect(connected.server.remoteIdentity).toEqual(harness.clientIdentity)
  })

  it('rejects replayed, reordered and modified encrypted frames', () => {
    const first = new RemoteControlPeerCodecTest().connect()
    const frame = first.client.outbound.seal({ type: 'heartbeat-ping', sentAt: 1 })
    expect(first.server.inbound.open(frame)).toEqual({ type: 'heartbeat-ping', sentAt: 1 })
    expect(() => first.server.inbound.open(frame)).toThrow('replayed or out of order')

    const second = new RemoteControlPeerCodecTest().connect()
    const modified = second.client.outbound.seal({ type: 'heartbeat-ping', sentAt: 2 })
    // A character that is CERTAINLY different. It used to be a literal `A`, and the key material is
    // random: about one run in sixty-four sealed a ciphertext already ending in `A`, the "change"
    // changed nothing, the frame opened cleanly and the test failed. It read as a load flake for
    // being rare, which is how it survived five sightings of `pnpm test` going red.
    const last = modified.ciphertext.slice(-1)
    modified.ciphertext = `${modified.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
    expect(() => second.server.inbound.open(modified)).toThrow('authentication failed')
  })

  it('rejects an unpaired or wrongly pinned client and server', () => {
    const harness = new RemoteControlPeerCodecTest()
    const state = harness.clientState()
    expect(() => harness.acceptClient(state.hello, () => null))
      .toThrowError(expect.objectContaining({ code: 'unauthorized' }))

    const other = RemoteControlPeerKeys.generateSigningKeyPair()
    const wrongTrust: RemoteControlPeerIdentity = {
      ...harness.clientIdentity,
      signing: RemoteControlPeerCodecTest.signing(other),
    }
    expect(() => harness.acceptClient(state.hello, () => wrongTrust))
      .toThrowError(expect.objectContaining({ code: 'unauthorized' }))

    const server = harness.acceptClient(state.hello)
    const wrongProfile: RemoteControlPeerProfile = {
      ...state.profile,
      pinnedIdentity: RemoteControlPeerCodecTest.signing(other),
    }
    expect(() => RemoteControlPeerCodec.acceptServerHello(
      server.hello,
      { ...state, profile: wrongProfile },
      RemoteControlPeerCodecTest.now,
    )).toThrowError(expect.objectContaining({ code: 'wrong-peer' }))
  })

  /*
   * The refusal of an unknown caller is what a person is later asked about, so it has to say who
   * asked - and only when the hello proved the key it carries is the caller's own. A known identity
   * arriving under another key is an impersonation attempt and must raise no question about itself.
   */
  it('names an unknown but self-proven caller, and nobody else', () => {
    const harness = new RemoteControlPeerCodecTest()
    const state = harness.clientState()

    const unknown = RemoteControlPeerCodecTest.refusal(
      () => harness.acceptClient(state.hello, () => null),
    )
    expect(unknown.code).toBe('unauthorized')
    expect(unknown.claimant).toEqual(harness.clientIdentity)

    const other = RemoteControlPeerKeys.generateSigningKeyPair()
    const unproven = RemoteControlPeerCodecTest.refusal(() => harness.acceptClient(
      {
        ...state.hello,
        signature: RemoteControlPeerKeys.sign(other.privateKey, Buffer.from('another payload')),
      },
      () => null,
    ))
    expect(unproven.code).toBe('unauthorized')
    expect(unproven.claimant).toBeUndefined()

    const impostor: RemoteControlPeerIdentity = {
      ...harness.clientIdentity,
      signing: RemoteControlPeerCodecTest.signing(other),
    }
    const mismatched = RemoteControlPeerCodecTest.refusal(
      () => harness.acceptClient(state.hello, () => impostor),
    )
    expect(mismatched.code).toBe('unauthorized')
    expect(mismatched.claimant).toBeUndefined()
  })

  it('rejects protocol mismatch, a reused hello and a signed identity changed in flight', () => {
    const harness = new RemoteControlPeerCodecTest()
    const state = harness.clientState()
    expect(() => harness.acceptClient({ ...state.hello, protocol: 'other' }))
      .toThrowError(expect.objectContaining({ code: 'protocol-mismatch' }))

    let accepted = false
    const acceptNonce = (): boolean => {
      if (accepted) return false
      accepted = true
      return true
    }
    harness.acceptClient(state.hello, undefined, acceptNonce)
    expect(() => harness.acceptClient(state.hello, undefined, acceptNonce))
      .toThrowError(expect.objectContaining({ code: 'replay' }))

    const changed: RemoteControlPeerClientHello = {
      ...state.hello,
      identity: { ...state.hello.identity, displayName: 'Changed after signing' },
    }
    expect(() => harness.acceptClient(changed))
      .toThrowError(expect.objectContaining({ code: 'unauthorized' }))
  })

  it('rejects a signed peer display name containing a structural line break', () => {
    const harness = new RemoteControlPeerCodecTest()
    harness.clientIdentity.displayName = 'Client\nroute: local'

    expect(() => harness.clientState())
      .toThrowError(expect.objectContaining({ code: 'invalid-handshake' }))
  })

  it('never negotiates target UI tab capabilities', () => {
    expect(RemoteControlPeerConst.controlOperations).not.toContain('tabs.open')
    expect(RemoteControlPeerConst.controlOperations).not.toContain('tabs.openFile')
    expect(RemoteControlPeerConst.controlOperations).not.toContain('tabs.close')
    expect(RemoteControlPeerConst.capabilities.some((capability) =>
      capability.startsWith('control:tabs.'))).toBe(false)

    // Asked for properly, signed and all: the refusal has to be the NEGOTIATION rather than the
    // decoder, or it would hold only for as long as nobody signs the request.
    const harness = new RemoteControlPeerCodecTest()
    const state = harness.clientState(['control:sessions.list', 'control:tabs.openFile'])

    const server = harness.acceptClient(state.hello)

    expect(server.capabilities).toEqual(['control:sessions.list'])
  })

  /*
   * The one thing a closed capability list must not do: refuse a peer for naming something it has
   * never heard of. Until 2026-08-31 it did, so the FIRST capability ever added would have broken
   * every connection to a build shipped before it - no missing feature, no degradation, no
   * connection. An unknown name is dropped where a capability becomes a grant, and the rest of the
   * handshake stands.
   */
  it('accepts a hello naming a capability this build has never heard of', () => {
    const harness = new RemoteControlPeerCodecTest()
    const state = harness.clientState([
      ...RemoteControlPeerConst.capabilities,
      'control:agents.forecast',
      'socket:terminal.telepathy',
    ])

    const server = harness.acceptClient(state.hello)
    const client = RemoteControlPeerCodec.acceptServerHello(
      server.hello,
      state,
      RemoteControlPeerCodecTest.now,
    )

    expect(server.capabilities).toEqual([...RemoteControlPeerConst.capabilities])
    expect(client.capabilities).toEqual([...RemoteControlPeerConst.capabilities])
    expect(server.capabilities).not.toContain('control:agents.forecast')
  })

  /* Tolerant is not unbounded: the shape, the length and the absence of duplicates still hold. */
  it('still refuses a capability list that is malformed, oversized or repeated', () => {
    const harness = new RemoteControlPeerCodecTest()
    const invalid: readonly unknown[][] = [
      [7],
      [''],
      ['control:sessions.list', 'control:sessions.list'],
      ['x'.repeat(129)],
      Array.from({ length: 129 }, (_value, index) => `control:made.up.${index}`),
    ]

    for (const capabilities of invalid)
      expect(() => harness.acceptClient({
        ...harness.clientState().hello,
        capabilities,
      }), JSON.stringify(capabilities).slice(0, 40))
        .toThrowError(expect.objectContaining({ code: 'invalid-handshake' }))
  })

  /*
   * Every other test here runs on one frozen clock, which is the one condition under which the
   * freshness window cannot be wrong: a hello is always exactly as old as it is new. The window is
   * what keeps a captured hello from being useful an hour later, so it is worth one test that moves
   * the clock.
   */
  it('accepts a hello inside the clock skew window and refuses one past it', () => {
    const world = new RemoteControlPeerCodecTest()
    const state = world.clientState()
    const skew = RemoteControlPeerCodec.maximumClockSkewMillisecondsConst

    expect(() => world.acceptClient(
      state.hello,
      () => world.clientIdentity,
      () => true,
      RemoteControlPeerCodecTest.now + skew,
    )).not.toThrow()
    expect(() => world.acceptClient(
      state.hello,
      () => world.clientIdentity,
      () => true,
      RemoteControlPeerCodecTest.now + skew + 1,
    )).toThrow()
    // And the same one behind our clock, which is the direction a replay comes from.
    expect(() => world.acceptClient(
      state.hello,
      () => world.clientIdentity,
      () => true,
      RemoteControlPeerCodecTest.now - skew - 1,
    )).toThrow()
  })

  it('names handshake errors without leaking key material', () => {
    const error = new RemoteControlPeerHandshakeError('wrong-peer', 'wrong target')
    expect(error.name).toBe('RemoteControlPeerHandshakeError')
    expect(error.code).toBe('wrong-peer')
    expect(error.message).toBe('wrong target')
  })
})

class RemoteControlPeerCodecTest {
  static readonly now = 1_800_000_000_000
  readonly clientKeys = RemoteControlPeerKeys.generateSigningKeyPair()
  readonly serverKeys = RemoteControlPeerKeys.generateSigningKeyPair()
  readonly clientIdentity = RemoteControlPeerCodecTest.identity(
    'client-computer',
    'client-endpoint',
    'Client',
    this.clientKeys,
  )
  readonly serverIdentity = RemoteControlPeerCodecTest.identity(
    'server-computer',
    'server-endpoint',
    'Server',
    this.serverKeys,
  )
  readonly profile: RemoteControlPeerProfile = {
    profileId: 'server-profile',
    remoteComputerId: this.serverIdentity.remoteComputerId,
    remoteEndpointId: this.serverIdentity.remoteEndpointId,
    configIdentity: this.serverIdentity.configIdentity,
    runtimeChannel: this.serverIdentity.runtimeChannel,
    displayName: this.serverIdentity.displayName,
    endpoint: { host: '127.0.0.1', port: 47_151 },
    pinnedIdentity: { ...this.serverIdentity.signing },
  }

  clientState(capabilities?: readonly string[]) {
    return RemoteControlPeerCodec.createClientHello(
      this.clientIdentity,
      this.profile,
      (payload) => RemoteControlPeerKeys.sign(this.clientKeys.privateKey, payload),
      {
        now: RemoteControlPeerCodecTest.now,
        connectionId: 'connection-123456',
        nonce: 'client-nonce-1234567890',
        ...(capabilities === undefined ? {} : { capabilities }),
      },
    )
  }

  acceptClient(
    hello: unknown,
    trustedInbound: (
      remoteComputerId: string,
      remoteEndpointId: string,
    ) => RemoteControlPeerIdentity | null = () => this.clientIdentity,
    acceptNonce: () => boolean = () => true,
    now: number = RemoteControlPeerCodecTest.now,
  ) {
    return RemoteControlPeerCodec.acceptClientHello(hello, {
      identity: this.serverIdentity,
      trustedInbound,
      sign: (payload) => RemoteControlPeerKeys.sign(this.serverKeys.privateKey, payload),
      acceptNonce,
      now,
    })
  }

  connect() {
    const state = this.clientState()
    const server = this.acceptClient(state.hello)
    const client = RemoteControlPeerCodec.acceptServerHello(
      server.hello,
      state,
      RemoteControlPeerCodecTest.now,
    )
    return { client, server }
  }

  static refusal(run: () => unknown): RemoteControlPeerHandshakeError {
    try { run() }
    catch (error) {
      if (error instanceof RemoteControlPeerHandshakeError) return error
      throw error
    }
    throw new Error('The handshake was accepted where a refusal was expected')
  }

  static identity(
    remoteComputerId: string,
    remoteEndpointId: string,
    displayName: string,
    keys: RemoteControlPeerSigningKeyPair,
  ): RemoteControlPeerIdentity {
    return {
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName,
      signing: RemoteControlPeerCodecTest.signing(keys),
    }
  }

  static signing(keys: RemoteControlPeerSigningKeyPair) {
    return {
      algorithm: 'ed25519' as const,
      publicKey: keys.publicKey,
      fingerprint: RemoteControlPeerKeys.fingerprint(keys.publicKey),
    }
  }
}
