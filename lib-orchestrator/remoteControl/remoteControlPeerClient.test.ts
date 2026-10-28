import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'

import { RemoteControlPeerClient } from './remoteControlPeerClient'
import { RemoteControlPeerKeys } from './remoteControlPeerKeys'
import { RemoteControlPeerCodec } from './remoteControlPeerCodec'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import type { RemoteControlPeerClientHello, RemoteControlPeerIdentity, RemoteControlPeerProfile } from './remoteControlPeerApi.types'

describe('LibOrchestrator/RemoteControl/RemoteControlPeerClient', () => {
  it('aborting a pending handshake terminates its socket and removes the abort listener', async () => {
    const fixture = new RemoteControlPeerClientTest()
    const abort = new AbortController()
    const pending = fixture.client.connect(fixture.profile, abort.signal)
    abort.abort()
    expect(await pending).to.deep.include({ ok: false, error: { code: 'unavailable', detail: 'Remote connection cancelled' } })
    expect(fixture.socket.terminated).to.equal(true)
    expect(fixture.socket.listenerCount('open')).to.equal(0)
    expect(fixture.socket.listenerCount('message')).to.equal(0)
    fixture.socket.emit('error', new Error('Late socket error after abort'))
  })

  it('an already cancelled dial never creates a socket', async () => {
    const fixture = new RemoteControlPeerClientTest()
    const abort = new AbortController()
    abort.abort()
    expect((await fixture.client.connect(fixture.profile, abort.signal)).ok).to.equal(false)
    expect(fixture.dials).to.equal(0)
  })

  it('retries a strict legacy vocabulary once with fresh key agreement, nonce and the same pin', async () => {
    const fixture = new RemoteControlPeerClientTest()
    const pending = fixture.client.connect(fixture.profile)
    fixture.socket.emit('open')
    const first = fixture.socket.hello!
    expect(first.capabilities).toContain('session-workspace.views')
    expect(() => fixture.acceptStrictLegacy(first)).toThrow('Unknown legacy capability')
    fixture.socket.emit('close', 1008)
    const legacy = fixture.sockets[1]!
    legacy.emit('open')
    const second = legacy.hello!
    expect(second.capabilities).toEqual([
      'control:system.hello', 'control:system.status', 'control:projects.list', 'control:sessions.list',
      'control:sessions.create', 'control:sessions.reopen', 'control:sessions.finalize',
      'control:terminal.peek', 'control:terminal.send',
      'socket:events.subscribe', 'socket:terminal.attach', 'socket:terminal.input',
      'socket:terminal.resize', 'socket:terminal.active', 'socket:terminal.detach',
    ])
    expect(second.nonce).not.toBe(first.nonce)
    expect(second.ephemeralPublicKey).not.toBe(first.ephemeralPublicKey)
    expect(second.connectionId).not.toBe(first.connectionId)
    expect(second.expectedRemoteEndpointId).toBe(first.expectedRemoteEndpointId)
    legacy.emit('message', Buffer.from(JSON.stringify(fixture.acceptStrictLegacy(second))), false)
    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.detail)
    expect(result.value.capabilities).toEqual(RemoteControlPeerConst.legacyCapabilities)
    legacy.emit('close', 1008)
    expect(fixture.dials).toBe(2)
    result.value.close()
  })

  it('stops after a second 1008 and cancellation also terminates the reduced-offer socket', async () => {
    for (const cancel of [false, true]) {
      const fixture = new RemoteControlPeerClientTest()
      const abort = new AbortController()
      const pending = fixture.client.connect(fixture.profile, abort.signal)
      fixture.socket.emit('open')
      fixture.socket.emit('close', 1008)
      const second = fixture.sockets[1]!
      second.emit('open')
      if (cancel) abort.abort()
      else second.emit('close', 1008)
      expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
      expect(fixture.dials).toBe(2)
      expect(second.terminated).toBe(true)
      expect(second.listenerCount('message')).toBe(0)
    }
  })

  it.each(['pin', 'signature', 'malformed', 'drop', 'error', 'timeout'] as const)('never retries %s failure', async (failure) => {
    const fixture = new RemoteControlPeerClientTest(15)
    const pending = fixture.client.connect(fixture.profile)
    fixture.socket.emit('open')
    if (failure === 'pin' || failure === 'signature') {
      const hello = fixture.accept(fixture.socket.hello!)
      if (failure === 'pin') hello.identity.remoteEndpointId = 'another-endpoint'
      else hello.signature = 'a'.repeat(86)
      fixture.socket.emit('message', Buffer.from(JSON.stringify(hello)), false)
    } else if (failure === 'malformed') fixture.socket.emit('message', Buffer.from('{}'), false)
    else if (failure === 'drop') fixture.socket.emit('close', 1006)
    else if (failure === 'error') fixture.socket.emit('error', new Error('unavailable'))
    else if (failure === 'timeout') { /* the real deadline completes the attempt */ }
    else throw new Error(`Unknown failure: ${failure}`)
    expect((await pending).ok).toBe(false)
    fixture.socket.emit('close', 1008)
    expect(fixture.dials).toBe(1)
  })
})

class RemoteControlPeerClientTest {
  readonly socket = new RemoteControlPeerClientTestSocket()
  readonly sockets: RemoteControlPeerClientTestSocket[] = []
  readonly profile: RemoteControlPeerProfile
  readonly client: RemoteControlPeerClient
  readonly identity: RemoteControlPeerIdentity
  readonly serverIdentity: RemoteControlPeerIdentity
  private readonly serverKeys = RemoteControlPeerKeys.generateSigningKeyPair()
  dials = 0

  constructor(connectTimeoutMilliseconds?: number) {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    const identity: RemoteControlPeerIdentity = {
      remoteComputerId: 'computer', remoteEndpointId: 'endpoint', configIdentity: 'config',
      runtimeChannel: 'development', displayName: 'Computer',
      signing: { algorithm: 'ed25519', publicKey: keys.publicKey, fingerprint: RemoteControlPeerKeys.fingerprint(keys.publicKey) },
    }
    this.identity = identity
    this.serverIdentity = {
      ...identity, remoteComputerId: 'target', remoteEndpointId: 'target-endpoint', configIdentity: 'target-config',
      signing: { algorithm: 'ed25519', publicKey: this.serverKeys.publicKey, fingerprint: RemoteControlPeerKeys.fingerprint(this.serverKeys.publicKey) },
    }
    this.profile = {
      profileId: 'profile', remoteComputerId: 'target', remoteEndpointId: 'target-endpoint',
      configIdentity: 'target-config', runtimeChannel: 'development', displayName: 'Target',
      endpoint: { host: '127.0.0.1', port: 47150 }, pinnedIdentity: this.serverIdentity.signing,
    }
    this.client = new RemoteControlPeerClient(identity, (payload) => RemoteControlPeerKeys.sign(keys.privateKey, payload), {
      connectTimeoutMilliseconds,
      socket: () => {
        const socket = this.dials++ === 0 ? this.socket : new RemoteControlPeerClientTestSocket()
        this.sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
  }

  accept(hello: RemoteControlPeerClientHello) {
    return RemoteControlPeerCodec.acceptClientHello(hello, {
      identity: this.serverIdentity, trustedInbound: () => this.identity,
      sign: (payload) => RemoteControlPeerKeys.sign(this.serverKeys.privateKey, payload), acceptNonce: () => true,
    }).hello
  }

  acceptStrictLegacy(hello: RemoteControlPeerClientHello) {
    const known = new Set([
      'control:system.hello', 'control:system.status', 'control:projects.list', 'control:sessions.list',
      'control:sessions.create', 'control:sessions.reopen', 'control:sessions.finalize',
      'control:terminal.peek', 'control:terminal.send',
      'socket:events.subscribe', 'socket:terminal.attach', 'socket:terminal.input',
      'socket:terminal.resize', 'socket:terminal.active', 'socket:terminal.detach',
    ])
    if (hello.capabilities.length > known.size || hello.capabilities.some((value) => !known.has(value)))
      throw new Error('Unknown legacy capability')
    return this.accept(hello)
  }
}

class RemoteControlPeerClientTestSocket extends EventEmitter {
  terminated = false
  hello: RemoteControlPeerClientHello | null = null
  send(text: string): void { this.hello = JSON.parse(text) }
  terminate(): void { this.terminated = true }
  close(): void { this.emit('close', 1000) }
}
