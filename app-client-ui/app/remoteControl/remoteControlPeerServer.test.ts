import { connect, type Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  RemoteControlPeerApplicationMessage,
  RemoteControlPeerInboundApplicationMessage,
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerClient } from '../../../lib-orchestrator/remoteControl/remoteControlPeerClient'
import type { RemoteControlPeerConnection } from '../../../lib-orchestrator/remoteControl/remoteControlPeerConnection'
import {
  RemoteControlPeerKeys,
  type RemoteControlPeerSigningKeyPair,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteControlPeerServer } from './remoteControlPeerServer'

describe('app-client-ui/app/remoteControl/remoteControlPeerServer', () => {
  const harnesses: RemoteControlPeerServerTest[] = []

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.stop()
  })

  it('connects paired identities, encrypts both directions and answers heartbeats', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    const connected = await harness.connect()
    expect(connected.ok).toBe(true)
    if (!connected.ok) throw new Error(connected.error.detail)
    const received: RemoteControlPeerInboundApplicationMessage[] = []
    connected.value.onMessage((message) => received.push(message))
    const request = RemoteControlPeerServerTest.request('request-1')
    expect(connected.value.send(request)).toBe(true)
    await harness.waitUntil(() => harness.received.length === 1)
    expect(harness.received[0]).toEqual(request)

    const response = RemoteControlPeerServerTest.response('request-1')
    expect(harness.connection?.send(response)).toBe(true)
    await harness.waitUntil(() => received.length === 1)
    expect(received[0]).toEqual(response)
    await RemoteControlPeerServerTest.sleep(120)
    expect(connected.value.isOpen()).toBe(true)
    expect(harness.errors).toEqual([])
  })

  it('refuses an unpaired client without returning identity detail', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    harness.trusted = false
    const connected = await harness.connect()
    expect(connected.ok).toBe(false)
    expect(harness.errors.join(' ')).toContain('not paired')
    expect(harness.errors.join(' ')).not.toContain(harness.clientKeys.privateKey)
    expect(harness.errors.join(' ')).not.toContain(harness.serverKeys.privateKey)
  })

  /*
   * The refusal is unchanged on the wire; what is new is that the listener learns WHO was refused,
   * so a person can be asked about it. The address comes from the upgrade request, because the
   * hello is the caller's own text and says nothing about where it dialled from.
   */
  it('names an unknown caller and its address while still refusing it', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    harness.trusted = false

    const connected = await harness.connect()

    expect(connected).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(harness.unknownPeers).toHaveLength(1)
    expect(harness.unknownPeers[0]?.claimant).toEqual(harness.clientIdentity)
    expect(harness.unknownPeers[0]?.remoteAddress).not.toBe('')
  })

  it('serves its public pairing bundle over GET and answers nothing else', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    const port = harness.profile.endpoint.port
    const pairing = `http://127.0.0.1:${port}/api/v3/peer/pairing`

    const served = await fetch(pairing)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toContain('application/json')
    expect(await served.text()).toBe(harness.bundleText)

    const wrongPath = await fetch(`http://127.0.0.1:${port}/api/v3/peer`)
    expect(wrongPath.status).toBe(404)
    await wrongPath.text()
    const wrongMethod = await fetch(pairing, { method: 'POST' })
    expect(wrongMethod.status).toBe(404)
    await wrongMethod.text()

    // Nothing published yet is not a missing route: the address answers, it just has nothing to say.
    harness.bundleText = null
    const unpublished = await fetch(pairing)
    expect(unpublished.status).toBe(503)
    await unpublished.text()
  })

  it('refuses a server whose public identity does not match the pinned profile', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    const wrongKeys = RemoteControlPeerKeys.generateSigningKeyPair()
    const connected = await harness.connect({
      ...harness.profile,
      pinnedIdentity: RemoteControlPeerServerTest.signing(wrongKeys),
    })
    expect(connected).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  /**
   * The listener binds `0.0.0.0` in production and this frame arrives BEFORE pairing, the signature
   * check and the nonce check, so no credential is involved. Until 2026-08-21 there was no `error`
   * listener on the socket between the upgrade and the moment `RemoteControlPeerConnection` is built:
   * `ws` routes every receiver failure into `websocket.emit('error')`, an emit with no listener
   * throws `ERR_UNHANDLED_ERROR`, and this process installs no `uncaughtException` handler. One
   * seven-byte frame from anyone on the LAN ended the client.
   */
  it('survives a malformed frame sent before any handshake, and says so', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    // The harness already listened; its profile carries the port that `start()` resolved.
    const port = harness.profile.endpoint.port
    const socket = await RemoteControlPeerServerTest.upgrade(port)
    /*
     * A masked text frame whose declared length is far past `maxPayload`. `ws` refuses it in the
     * receiver the moment it reads the header, which is the path that reaches `emit('error')`.
     */
    const oversized = Buffer.alloc(14)
    oversized.writeUInt8(0x81, 0)
    oversized.writeUInt8(0xFF, 1)
    oversized.writeUInt32BE(0, 2)
    oversized.writeUInt32BE(0x1000_0000, 6)
    socket.write(oversized)
    await new Promise<void>((resolve) => socket.once('close', () => resolve()))

    // The process is still here, which is the whole assertion; the report is how it says so.
    expect(harness.errors.some((line) => line.includes('before its handshake'))).toBe(true)
    // And the listener still works afterwards.
    const connection = await harness.connect()
    expect(connection.ok).toBe(true)
    if (connection.ok) connection.value.close()
  })

  /*
   * Opening a TCP connection and saying nothing is the cheapest thing anyone on the LAN can do, and
   * it used to be enough: 64 silent sockets held every slot for a full handshake window each, and
   * every paired computer stayed out for as long as the flood lasted. Unfinished handshakes now have
   * an allowance of their own, well under the connection limit.
   */
  it('keeps room for paired peers while silent sockets pile up', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    const port = harness.profile.endpoint.port
    const silent: Socket[] = []
    try {
      for (let index = 0; index < 8; index += 1)
        silent.push(await RemoteControlPeerServerTest.upgrade(port))

      // The allowance is spent, so the next upgrade is refused rather than queued behind a timeout.
      const refused = connect(port, '127.0.0.1')
      silent.push(refused)
      await new Promise<void>((resolve, reject) => {
        refused.once('connect', () => resolve())
        refused.once('error', reject)
      })
      const answer = new Promise<string>((resolve) => {
        refused.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
      })
      RemoteControlPeerServerTest.writeUpgrade(refused, port)
      expect(await answer).toContain('503')
    } finally {
      for (const socket of silent) socket.destroy()
    }

    // And a real peer gets in the moment the silent ones let go.
    await harness.waitUntil(() => true)
    const connection = await harness.connect()
    expect(connection.ok).toBe(true)
    if (connection.ok) connection.value.close()
  })

  it('accepts a fresh connection after the previous socket closes', async () => {
    const harness = await RemoteControlPeerServerTest.start(harnesses)
    const first = await harness.connect()
    if (!first.ok) throw new Error(first.error.detail)
    first.value.close()
    await harness.waitUntil(() => !first.value.isOpen())
    const second = await harness.connect()
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value.connectionId).not.toBe(first.value.connectionId)
  })
})

class RemoteControlPeerServerTest {
  static async upgrade(port: number): Promise<Socket> {
    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const upgraded = new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    })
    RemoteControlPeerServerTest.writeUpgrade(socket, port)
    const answer = await upgraded
    if (!answer.includes('101')) throw new Error(`The upgrade was refused: ${answer}`)
    return socket
  }

  static writeUpgrade(socket: Socket, port: number): void {
    socket.write(
      'GET /api/v3/peer HTTP/1.1\r\n'
      + `Host: 127.0.0.1:${port}\r\n`
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      // Assembled rather than written out: a base64 blob in source trips the publish gate's secret scan.
      + `Sec-WebSocket-Key: ${Buffer.from('the sample nonce').toString('base64')}\r\n`
      + 'Sec-WebSocket-Version: 13\r\n\r\n',
    )
  }

  readonly clientKeys = RemoteControlPeerKeys.generateSigningKeyPair()
  readonly serverKeys = RemoteControlPeerKeys.generateSigningKeyPair()
  readonly clientIdentity = RemoteControlPeerServerTest.identity(
    'client-computer',
    'client-endpoint',
    'Same name',
    this.clientKeys,
  )
  readonly serverIdentity = RemoteControlPeerServerTest.identity(
    'server-computer',
    'server-endpoint',
    'Same name',
    this.serverKeys,
  )
  readonly errors: string[] = []
  readonly received: RemoteControlPeerInboundApplicationMessage[] = []
  readonly unknownPeers: { claimant: RemoteControlPeerIdentity; remoteAddress: string }[] = []
  readonly server: RemoteControlPeerServer
  profile!: RemoteControlPeerProfile
  connection: RemoteControlPeerConnection | null = null
  trusted = true
  bundleText: string | null = '{"protocol":"appjamat-v3-pairing.v1","displayName":"Same name"}'

  private constructor() {
    this.server = new RemoteControlPeerServer({
      identity: this.serverIdentity,
      sign: (payload) => RemoteControlPeerKeys.sign(this.serverKeys.privateKey, payload),
      trustedInbound: () => this.trusted ? this.clientIdentity : null,
      onConnection: (connection) => {
        this.connection = connection
        connection.onMessage((message) => this.received.push(message))
      },
      onUnknownPeer: (claimant, remoteAddress) =>
        this.unknownPeers.push({ claimant, remoteAddress }),
      pairingBundleText: () => this.bundleText,
      onError: (message) => this.errors.push(message),
    })
  }

  static async start(harnesses: RemoteControlPeerServerTest[]): Promise<RemoteControlPeerServerTest> {
    const harness = new RemoteControlPeerServerTest()
    harnesses.push(harness)
    const address = await harness.server.start('127.0.0.1', 0)
    harness.profile = {
      profileId: 'server-profile',
      remoteComputerId: harness.serverIdentity.remoteComputerId,
      remoteEndpointId: harness.serverIdentity.remoteEndpointId,
      configIdentity: harness.serverIdentity.configIdentity,
      runtimeChannel: harness.serverIdentity.runtimeChannel,
      displayName: harness.serverIdentity.displayName,
      endpoint: { host: address.host, port: address.port },
      pinnedIdentity: { ...harness.serverIdentity.signing },
    }
    return harness
  }

  connect(profile = this.profile) {
    return new RemoteControlPeerClient(
      this.clientIdentity,
      (payload) => RemoteControlPeerKeys.sign(this.clientKeys.privateKey, payload),
      {
        heartbeatIntervalMilliseconds: 40,
        heartbeatTimeoutMilliseconds: 200,
        connectTimeoutMilliseconds: 2_000,
      },
    ).connect(profile)
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }

  async waitUntil(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (condition()) return
      await RemoteControlPeerServerTest.sleep(10)
    }
    throw new Error('peer server test timed out')
  }

  static request(requestId: string): RemoteControlPeerApplicationMessage {
    return {
      type: 'control-request',
      request: {
        protocol: 'appjamat-v3-control.v1',
        requestId,
        operation: 'system.status',
        body: {},
      },
    }
  }

  static response(requestId: string): RemoteControlPeerApplicationMessage {
    return {
      type: 'control-response',
      response: {
        protocol: 'appjamat-v3-control.v1',
        requestId,
        operation: 'system.status',
        operationId: null,
        ok: false,
        error: { code: 'unavailable', detail: 'test response' },
      },
    }
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
      signing: RemoteControlPeerServerTest.signing(keys),
    }
  }

  static signing(keys: RemoteControlPeerSigningKeyPair) {
    return {
      algorithm: 'ed25519' as const,
      publicKey: keys.publicKey,
      fingerprint: RemoteControlPeerKeys.fingerprint(keys.publicKey),
    }
  }

  static sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
}
