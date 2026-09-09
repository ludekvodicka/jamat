import { createServer, type Server } from 'node:http'

import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  RemoteControlDescriptor,
  RemoteControlLocalRequest,
  RemoteControlRequest,
  RemoteControlSocketResponse,
} from './remoteControlApi.types'
import { RemoteControlConst, RemoteControlLocalConst } from './remoteControlProtocol'
import { RemoteControlClient } from './remoteControlClient'

class FakeRemoteControlEndpoint {
  readonly authorizations: (string | undefined)[] = []
  readonly paths: string[] = []
  readonly subscriptions: unknown[] = []
  private readonly server: Server
  private readonly sockets: WebSocketServer
  private port = 0

  private constructor() {
    this.server = createServer((request, response) => {
      this.authorizations.push(request.headers.authorization)
      this.paths.push(request.url ?? '')
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        const value = parsed.body as Record<string, unknown>
        const answer = value.invalidResponse === true
          ? { wrong: true }
          : {
              protocol: RemoteControlConst.protocol,
              requestId: parsed.requestId,
              operation: parsed.operation,
              operationId: parsed.operationId ?? null,
              ok: true,
              value: parsed.operation === 'sessions.transcript'
                ? Object.hasOwn(value, 'response')
                  ? value.response
                  : {
                      sessionId: 'session-1',
                      transcriptContentUntrusted: true,
                      reading: { kind: 'none', code: 'not-agent', reason: 'not an agent session' },
                    }
                : { echoed: value },
            }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(answer))
      })
    })
    this.sockets = new WebSocketServer({ server: this.server, path: '/api/v3/ws' })
    this.sockets.on('connection', (socket, request) => {
      this.authorizations.push(request.headers.authorization)
      socket.on('message', (data) => {
        const subscription = JSON.parse(data.toString()) as Record<string, unknown>
        this.subscriptions.push(subscription)
        if (typeof subscription.requestId !== 'string')
          throw new Error('Fake subscription has no request id')
        socket.send(JSON.stringify({
          protocol: RemoteControlConst.protocol,
          type: 'response',
          requestId: subscription.requestId,
          operation: 'events.subscribe',
          operationId: null,
          ok: true,
          value: { throughRevision: 1, truncated: false },
        } satisfies RemoteControlSocketResponse))
        socket.send(JSON.stringify({
          protocol: RemoteControlConst.protocol,
          type: 'event',
          event: { revision: 2, kind: 'sessions.changed', at: 2_000 },
        } satisfies RemoteControlSocketResponse))
      })
    })
  }

  static async start(): Promise<FakeRemoteControlEndpoint> {
    const endpoint = new FakeRemoteControlEndpoint()
    await new Promise<void>((resolve, reject) => {
      endpoint.server.once('error', reject)
      endpoint.server.listen(0, '127.0.0.1', () => {
        endpoint.server.off('error', reject)
        resolve()
      })
    })
    const address = endpoint.server.address()
    if (address === null || typeof address === 'string')
      throw new Error('Fake control endpoint did not bind')
    endpoint.port = address.port
    return endpoint
  }

  descriptor(): RemoteControlDescriptor {
    return {
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      port: this.port,
      pid: process.pid,
      token: 'fake-control-token-that-is-long-enough',
      operations: RemoteControlConst.operations,
      localOperations: RemoteControlLocalConst.operations,
      websocket: true,
      configIdentity: 'config-1',
      runtimeChannel: 'development',
      instanceId: 'instance-1',
      startedAt: 1,
      applicationVersion: '1.0.0',
    }
  }

  async stop(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate()
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()))
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

describe('lib-orchestrator/remoteControl/remoteControlClient', () => {
  const endpoints: FakeRemoteControlEndpoint[] = []

  afterEach(async () => {
    for (const endpoint of endpoints.splice(0)) await endpoint.stop()
  })

  it('posts the typed envelope with bearer auth and validates the matching response', async () => {
    const endpoint = await FakeRemoteControlEndpoint.start()
    endpoints.push(endpoint)
    const client = new RemoteControlClient(endpoint.descriptor())
    const request: RemoteControlRequest<'sessions.list'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.list',
      body: {},
    }

    await expect(client.execute(request)).resolves.toEqual({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.list',
      operationId: null,
      ok: true,
      value: { echoed: {} },
    })
    expect(endpoint.authorizations).toEqual([
      `Bearer ${endpoint.descriptor().token}`,
    ])
  })

  it('uses separate local-management and endpoint-scoped remote routes', async () => {
    const endpoint = await FakeRemoteControlEndpoint.start()
    endpoints.push(endpoint)
    const client = new RemoteControlClient(endpoint.descriptor())
    const local: RemoteControlLocalRequest<'remote.computers.list'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'local-1',
      operation: 'remote.computers.list',
      body: {},
    }
    const remote: RemoteControlRequest<'sessions.list'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'remote-1',
      operation: 'sessions.list',
      body: {},
    }

    await expect(client.executeLocal(local)).resolves.toMatchObject({ ok: true })
    await expect(client.executeRemote('endpoint:a', remote)).resolves.toMatchObject({ ok: true })
    expect(endpoint.paths).toEqual([
      '/api/v3/local/op/remote.computers.list',
      '/api/v3/remote/endpoint%3Aa/op/sessions.list',
    ])

    await expect(client.executeRemote('endpoint:a', {
      protocol: RemoteControlConst.protocol,
      requestId: 'tabs-1',
      operation: 'tabs.list',
      body: {},
    })).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(endpoint.paths).toHaveLength(2)
  })

  it('turns incompatible and unreachable endpoints into stable errors without token leakage', async () => {
    const endpoint = await FakeRemoteControlEndpoint.start()
    endpoints.push(endpoint)
    const descriptor = endpoint.descriptor()
    const client = new RemoteControlClient(descriptor)
    const invalid: RemoteControlRequest<'projects.list'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'invalid',
      operation: 'projects.list',
      body: { categoryId: 'x' },
    }
    const invalidAnswer = await client.execute({
      ...invalid,
      body: { categoryId: 'x', invalidResponse: true } as never,
    })
    await endpoint.stop()
    endpoints.splice(endpoints.indexOf(endpoint), 1)
    const unavailable = await client.execute(invalid)

    expect(invalidAnswer).toMatchObject({
      ok: false,
      error: { code: 'operation-failed' },
    })
    expect(unavailable).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify([invalidAnswer, unavailable])).not.toContain(descriptor.token)
  })

  it('composes an external deadline signal with the per-request timeout', async () => {
    const endpoint = await FakeRemoteControlEndpoint.start()
    endpoints.push(endpoint)
    const abort = new AbortController()
    const observed: { signal?: AbortSignal } = {}
    const client = new RemoteControlClient(endpoint.descriptor(), {
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        if (!(init?.signal instanceof AbortSignal))
          throw new Error('The request has no abort signal')
        observed.signal = init.signal
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      }),
    })
    const request: RemoteControlRequest<'sessions.list'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'aborted-discovery',
      operation: 'sessions.list',
      body: {},
    }

    const answer = client.execute(request, abort.signal)
    abort.abort()

    await expect(answer).resolves.toMatchObject({
      ok: false,
      error: { code: 'timeout' },
    })
    expect(observed.signal?.aborted).toBe(true)
  })

  it('refuses an unadvertised optional capability before fetch', async () => {
    const endpoint = await FakeRemoteControlEndpoint.start()
    endpoints.push(endpoint)
    const client = new RemoteControlClient(endpoint.descriptor())
    const request: RemoteControlRequest<'sessions.transcript'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'transcript-1',
      operation: 'sessions.transcript',
      body: { session: { kind: 'sessionId', sessionId: 'session-1' } },
    }

    await expect(client.execute(request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', detail: 'sessions.transcript is not exposed by this AppClientUI' },
    })
    expect(endpoint.paths).toEqual([])

    const advertised = endpoint.descriptor()
    advertised.optionalOperations = RemoteControlConst.optionalOperations
    await expect(new RemoteControlClient(advertised).execute(request))
      .resolves.toMatchObject({ ok: true })
    expect(endpoint.paths).toEqual(['/api/v3/op/sessions.transcript'])
  })

  it('refuses malformed transcript markers, none codes, bounds and messages as incompatible', async () => {
    const endpoint = await FakeRemoteControlEndpoint.start()
    endpoints.push(endpoint)
    const descriptor = endpoint.descriptor()
    descriptor.optionalOperations = RemoteControlConst.optionalOperations
    const client = new RemoteControlClient(descriptor)
    const valid = {
      sessionId: 'session-1',
      transcriptContentUntrusted: true,
      reading: {
        kind: 'messages',
        messages: [{ role: 'assistant', text: 'done', at: 2_000, textTruncated: false }],
        bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 128 },
        earlierContentOmitted: false,
      },
    }
    const malformed = [
      { ...valid, transcriptContentUntrusted: false },
      { ...valid, transcriptPath: 'Q:/private/transcript.jsonl' },
      {
        ...valid,
        reading: { kind: 'none', code: 'unknown-session', reason: 'not stable' },
      },
      {
        ...valid,
        reading: {
          ...valid.reading,
          bounds: { ...valid.reading.bounds, maxMessages: -1 },
        },
      },
      {
        ...valid,
        reading: {
          ...valid.reading,
          messages: [{ role: 'system', text: 'bad', at: null, textTruncated: false }],
        },
      },
    ]

    for (const [index, response] of malformed.entries()) {
      const request = {
        protocol: RemoteControlConst.protocol,
        requestId: `malformed-transcript-${index}`,
        operation: 'sessions.transcript',
        body: {
          session: { kind: 'sessionId', sessionId: 'session-1' },
          response,
        },
      } as unknown as RemoteControlRequest<'sessions.transcript'>
      await expect(client.execute(request)).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation-failed', detail: 'AppClientUI returned an incompatible control response' },
      })
    }
    expect(endpoint.paths).toEqual(malformed.map(() => '/api/v3/op/sessions.transcript'))
  })

  it('subscribes from a cursor, emits versioned messages and closes cleanly on abort', async () => {
    const endpoint = await FakeRemoteControlEndpoint.start()
    endpoints.push(endpoint)
    const abort = new AbortController()
    const messages: Exclude<RemoteControlSocketResponse, { type: 'terminal.frame' }>[] = []
    const watched = new RemoteControlClient(endpoint.descriptor(), {
      requestId: () => 'subscription-1',
    }).watchEvents({
      afterRevision: 1,
      signal: abort.signal,
      onMessage: (message) => {
        messages.push(message)
        if (message.type === 'event') abort.abort()
      },
    })

    await expect(watched).resolves.toEqual({ ok: true, value: undefined })
    expect(endpoint.subscriptions).toEqual([{
      protocol: RemoteControlConst.protocol,
      requestId: 'subscription-1',
      operation: 'events.subscribe',
      afterRevision: 1,
    }])
    expect(messages).toMatchObject([
      { type: 'response', requestId: 'subscription-1', ok: true },
      { type: 'event', event: { revision: 2, kind: 'sessions.changed' } },
    ])
  })
})
