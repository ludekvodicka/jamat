import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import type { RemoteControlPeerIdentity } from './remoteControlPeerApi.types'
import { RemoteControlPairing } from './remoteControlPairing'
import { RemoteControlPairingProbe } from './remoteControlPairingProbe'
import { RemoteControlPeerKeys } from './remoteControlPeerKeys'

describe('lib-orchestrator/remoteControl/remoteControlPairingProbe', () => {
  const servers: PairingProbeTestServer[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop()
  })

  const serve = async (
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<PairingProbeTestServer> => {
    const server = await PairingProbeTestServer.start(handler)
    servers.push(server)
    return server
  }

  it('reads the public bundle an address serves', async () => {
    const bundle = PairingProbeTest.bundle()
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(bundle))
    })

    const probed = await RemoteControlPairingProbe.fetch(server.endpoint())

    expect(probed).toEqual({ ok: true, bundle })
    // One GET on the one path, and nothing else: the probe is the whole conversation.
    expect(server.requests).toEqual(['GET /api/v3/peer/pairing'])
  })

  it('refuses an address that answers with anything but 200', async () => {
    const unpublished = await serve((_request, response) => {
      response.writeHead(503, { 'Content-Length': '0' })
      response.end()
    })
    const missing = await serve((_request, response) => {
      response.writeHead(404, { 'Content-Length': '0' })
      response.end()
    })

    expect(await RemoteControlPairingProbe.fetch(unpublished.endpoint()))
      .toMatchObject({ ok: false, detail: expect.stringContaining('503') })
    // An older build has no route at all, which is the sentence the screen turns into "paste its
    // bundle instead".
    expect(await RemoteControlPairingProbe.fetch(missing.endpoint()))
      .toMatchObject({ ok: false, detail: expect.stringContaining('404') })
  })

  it('refuses a body over the cap without reading it whole', async () => {
    const bundle = PairingProbeTest.bundle()
    let sent = 0
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const padding = 'x'.repeat(64 * 1024)
      // Far more than the cap, written in pieces: what is proven is that the probe lets go partway,
      // not that it survived buffering all of it.
      for (let index = 0; index < 64; index += 1) {
        sent += padding.length
        response.write(padding)
      }
      response.end(JSON.stringify(bundle))
    })

    const probed = await RemoteControlPairingProbe.fetch(server.endpoint())

    expect(probed).toMatchObject({ ok: false, detail: expect.stringContaining('pairing info') })
    expect(sent).toBeGreaterThan(RemoteControlPairingProbe.maximumBodyBytesConst)
  })

  it('refuses a body that is not a pairing bundle', async () => {
    const notJson = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('not json at all')
    })
    const notBundle = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ schemaVersion: 2, protocol: 'something-else' }))
    })

    expect(await RemoteControlPairingProbe.fetch(notJson.endpoint())).toMatchObject({ ok: false })
    expect(await RemoteControlPairingProbe.fetch(notBundle.endpoint()))
      .toMatchObject({ ok: false, detail: expect.stringContaining('invalid') })
  })

  it('gives up on an address that accepts the request and never answers', async () => {
    const server = await serve(() => undefined)

    const probed = await RemoteControlPairingProbe.fetch(
      server.endpoint(),
      { timeoutMilliseconds: 100 },
    )

    expect(probed).toMatchObject({ ok: false })
  })

  /**
   * A redirect is the one answer that would pin a computer nobody typed the address of: the person
   * compares the fingerprint against the machine they meant to reach, and a followed `302` would
   * hand them another machine's.
   */
  it('never follows a redirect to another host', async () => {
    const elsewhere = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(PairingProbeTest.bundle()))
    })
    const redirecting = await serve((_request, response) => {
      response.writeHead(302, {
        Location: `http://127.0.0.1:${elsewhere.port()}/api/v3/peer/pairing`,
        'Content-Length': '0',
      })
      response.end()
    })

    const probed = await RemoteControlPairingProbe.fetch(redirecting.endpoint())

    expect(probed).toMatchObject({ ok: false })
    expect(elsewhere.requests).toEqual([])
  })
})

class PairingProbeTest {
  static bundle() {
    const keys = RemoteControlPeerKeys.generateSigningKeyPair()
    const identity: RemoteControlPeerIdentity = {
      remoteComputerId: 'computer-probe',
      remoteEndpointId: 'endpoint-probe',
      configIdentity: 'config-probe',
      runtimeChannel: 'development',
      displayName: 'Probe computer',
      signing: {
        algorithm: 'ed25519',
        publicKey: keys.publicKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(keys.publicKey),
      },
    }
    return RemoteControlPairing.bundle(identity, { host: '127.0.0.1', port: 47_150 })
  }
}

class PairingProbeTestServer {
  readonly requests: string[] = []

  private constructor(private readonly server: Server) {}

  static start(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<PairingProbeTestServer> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      const started = new PairingProbeTestServer(server)
      server.on('request', (request, response) => {
        started.requests.push(`${request.method ?? ''} ${request.url ?? ''}`)
        handler(request, response)
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(started))
    })
  }

  port(): number {
    const address = this.server.address()
    if (address === null || typeof address === 'string')
      throw new Error('The probe test server has no port')
    return address.port
  }

  endpoint() {
    return { host: '127.0.0.1', port: this.port() }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections()
      this.server.close(() => resolve())
    })
  }
}
