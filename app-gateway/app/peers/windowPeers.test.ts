import type { RemoteSessionViewRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { beforeEach, afterEach, describe, it, mock } from 'node:test'

import type { RemoteControlRequestUnion } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerApplicationMessage } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { WindowRemoteInvokeMap, WindowRemoteCall } from '../../../lib-orchestrator/remoteControl/windowRemote.types'
type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }
import type { RemoteOutboundPort } from '../../../lib-orchestrator/remoteControl/remoteOutbound.types'
import type { WindowTerminalPayload } from '../../../lib-orchestrator/shared/windowWire.types'
import { ViewerBuffer } from '../terminals/viewerBuffer'
import { WindowPeers, type WindowPeersDependencies } from './windowPeers'

describe('WindowPeers renderer authority', () => {
  const calls: { method: string; args: unknown[] }[] = []
  let service: WindowPeersFixture
  let onFrame: ((frame: unknown) => void) | null

  beforeEach(() => {
    calls.length = 0
    onFrame = null
    service = new WindowPeersFixture(
      WindowPeersTest.outbound(calls, (callback) => { onFrame = callback }),
      { snapshot: () => [WindowPeersTest.inbound()] },
      {
        revision: () => 9,
        acceptsRenderer: () => true,
      },
    )
  })

  afterEach(() => service.close())

  it('combines outbound and inbound without credentials', async () => {
    const sender = new WindowPeersTestSender()
    const answer = await WindowPeersTest.invoke('remote:snapshot', sender)
    assert.partialDeepStrictEqual(answer, {
      ok: true,
      value: { revision: 9, outbound: [{ remoteEndpointId: 'outbound' }], inbound: [{ connectionId: 'inbound' }] },
    })
    if (!answer.ok) throw new Error(answer.error)
    assert.equal(answer.value.outbound.length, 1)
    assert.equal(answer.value.inbound.length, 1)
    const serialized = JSON.stringify(answer)
    assert.equal((serialized).includes('publicKey'), false)
    assert.equal((serialized).includes('privateKey'), false)
    assert.equal((serialized).includes('token'), false)
  })

  it('preserves source command operation IDs and admits no approval through the generic command channel', async () => {
    const sender = new WindowPeersTestSender()
    const command = { operation: 'sessions.fork' as const, operationId: 'one-fork', body: { session: { kind: 'sessionId' as const, sessionId: 'source' } } }
    await WindowPeersTest.invoke('remote:session-command', sender, 'endpoint-a', command)
    assert.partialDeepStrictEqual(calls.find(call => call.method === 'execute'), { method: 'execute', args: ['endpoint-a', command] })
    const answer = await WindowPeersTest.invoke('remote:session-command', sender, 'endpoint-a', {
      ...command, operation: 'sessions.finishWorktree', body: { ...command.body, choice: 'commit', confirmWorking: true },
    } as never)
    assert.equal(answer.ok, false)
    if (answer.ok) throw new Error('Forbidden command was accepted')
    assert.match(answer.error, /not admitted/)
    assert.equal((calls.filter((call) => call.method === 'execute')).length, 1)
  })

  /*
   * Two windows on the same screen are two holds, so one closing its card cannot hang up the other
   * one's connection. The key carries the window and the reason for exactly that reason.
   */
  it('holds and releases per window and per reason', async () => {
    const one = new WindowPeersTestSender()
    const two = new WindowPeersTestSender()
    await WindowPeersTest.invoke('remote:connect', one, 'network-settings', 'target-endpoint')
    await WindowPeersTest.invoke('remote:connect', two, 'network-settings', 'target-endpoint')
    await WindowPeersTest.invoke('remote:release', one, 'network-settings')

    assert.deepEqual(calls.filter((call) => ['connectComputer', 'releaseConnections'].includes(call.method)), [
        { method: 'connectComputer', args: [`renderer ${one.id} network-settings`, 'target-endpoint'] },
        { method: 'connectComputer', args: [`renderer ${two.id} network-settings`, 'target-endpoint'] },
        { method: 'releaseConnections', args: [`renderer ${one.id} network-settings`] },
      ])
  })

  /*
   * A window that dies without releasing would otherwise keep every paired computer dialled for the
   * life of the process, which is the state dialling on demand exists to end.
   */
  it('releases every hold a window held when that window dies', async () => {
    const sender = new WindowPeersTestSender()
    await WindowPeersTest.invoke('remote:connect', sender, 'launcher-computers', 'target-endpoint')
    await WindowPeersTest.invoke('remote:connect', sender, 'network-settings', 'target-endpoint')
    calls.length = 0

    sender.fire('destroyed')

    assert.deepEqual(calls.map((call) => call.args[0]).sort(), [
      `renderer ${sender.id} launcher-computers`,
      `renderer ${sender.id} network-settings`,
    ])
  })

  it('refuses worktree creation before sending to a peer without setup views', async () => {
    const sender = new WindowPeersTestSender()
    const answer = await WindowPeersTest.invoke('remote:sessions-create', sender, 'outbound',
      { kind: 'shell', directory: { mode: 'default' }, worktree: { slug: 'child' } }, 'child-create')
    assert.partialDeepStrictEqual(answer, { ok: true, value: { ok: false, error: { code: 'unavailable' } } })
    assert.deepEqual(calls.filter((call) => call.method === 'execute'), [])
  })

  it('builds exact semantic requests for create, reopen and finalize', async () => {
    const sender = new WindowPeersTestSender()
    await WindowPeersTest.invoke(
      'remote:sessions-create',
      sender,
      'endpoint-a',
      { kind: 'shell', directory: { mode: 'default' } },
      'operation-id',
    )
    await WindowPeersTest.invoke(
      'remote:sessions-reopen',
      sender,
      'endpoint-a',
      'session-a',
    )
    await WindowPeersTest.invoke(
      'remote:sessions-finalize',
      sender,
      'endpoint-a',
      'session-a',
    )
    const requests = calls.filter((call) => call.method === 'execute')
      .map((call) => call.args[1] as RemoteControlPeerApplicationMessage)
    assert.equal((requests).length, 3)
    assert.partialDeepStrictEqual((requests)[0], { operation: 'sessions.create', operationId: 'operation-id' })
    assert.partialDeepStrictEqual((requests)[1], { operation: 'sessions.reopen', body: { session: { sessionId: 'session-a' } } })
    assert.partialDeepStrictEqual((requests)[2], { operation: 'sessions.finalize', body: { session: { sessionId: 'session-a' } } })
  })

  /** An older target refuses an unknown key with the whole request, so a press nobody agreed on sends none. */
  it('carries the agreed hash on a finalize only when the overlay sends one', async () => {
    const sender = new WindowPeersTestSender()

    await WindowPeersTest.invoke('remote:sessions-finalize', sender, 'endpoint-a', 'session-a')
    await WindowPeersTest.invoke(
      'remote:sessions-finalize', sender, 'endpoint-a', 'session-a', 'hash-1')

    const bodies = calls.filter((call) => call.method === 'execute')
      .map((call) => (call.args[1] as RemoteControlRequestUnion).body)
    assert.deepEqual(bodies, [
      { session: { kind: 'sessionId', sessionId: 'session-a' } },
      { session: { kind: 'sessionId', sessionId: 'session-a' }, acknowledgeSetup: 'hash-1' },
    ])
  })

  /**
   * The whole point of the caller's id: the same body sent twice with the same id is one operation
   * to the far side's replay store, and a fresh id per call would have made a Retry after a lost
   * answer create a second session. The service mints ids for everything else and must not for this.
   */
  it('sends the caller operation id for a create, and the same one again on a retry', async () => {
    const sender = new WindowPeersTestSender()
    const spec = { kind: 'shell', directory: { mode: 'default' } }

    await WindowPeersTest.invoke(
      'remote:sessions-create', sender, 'endpoint-a', spec, 'intent-7')
    await WindowPeersTest.invoke(
      'remote:sessions-create', sender, 'endpoint-a', spec, 'intent-7')

    const requests = calls.filter((call) => call.method === 'execute')
      .map((call) => call.args[1] as RemoteControlPeerApplicationMessage)
    assert.equal((requests).length, 2)
    assert.partialDeepStrictEqual((requests)[0], { operation: 'sessions.create', operationId: 'intent-7' })
    assert.partialDeepStrictEqual((requests)[1], { operation: 'sessions.create', operationId: 'intent-7' })
  })

  /**
   * The far side refuses an operationId on an operation that does not mutate, and refuses the whole
   * request for it. Both reads here shipped with one until the remote-app smoke drove them over a
   * real socket and got `invalid-request` back, so the ABSENCE is what is pinned.
   */
  it('asks the paired computer for its own catalog and its own agents, with no operation id', async () => {
    const sender = new WindowPeersTestSender()

    await WindowPeersTest.invoke(
      'remote:projects-list', sender, 'endpoint-a', { categoryId: 'nodejs', sort: 'recent' })
    await WindowPeersTest.invoke('remote:agents-describe', sender, 'endpoint-a')
    await WindowPeersTest.invoke('remote:accounts-list', sender, 'endpoint-a')

    const requests = calls.filter((call) => call.method === 'execute').map((call) => call.args[1])
    assert.equal((requests).length, 3)
    assert.partialDeepStrictEqual((requests)[0], { operation: 'projects.list', body: { categoryId: 'nodejs', sort: 'recent' } })
    assert.partialDeepStrictEqual((requests)[1], { operation: 'agents.describe', body: {} })
    assert.partialDeepStrictEqual((requests)[2], { operation: 'accounts.list', body: {} })
    assert.equal(requests.every((request) =>
      !Object.hasOwn(request as Record<string, unknown>, 'operationId')), true)
  })

  /**
   * The one remote channel that sends nothing over the wire: what the paired computer already pushed
   * is what the block is made of, so the manager answers on its own and `execute` is never reached.
   */
  it('answers the reference from what is held rather than by asking the other computer', async () => {
    const sender = new WindowPeersTestSender()

    const answer = await WindowPeersTest.invoke(
      'remote:sessions-reference',
      sender,
      'endpoint-a',
      'session-a',
    )

    assert.deepEqual(answer, {
      ok: true,
      value: { ok: true, value: { text: 'AppJamatV3 session remote session-a' } },
    })
    assert.deepEqual(calls, [{ method: 'sessionReference', args: ['endpoint-a', 'session-a'] }])
  })

  it('routes terminal frames only to the owning renderer and cleans up on navigation', async () => {
    const sender = new WindowPeersTestSender()
    await WindowPeersTest.invoke(
      'remote:terminal-attach',
      sender,
      'endpoint-a',
      'attach-a',
      { sessionId: 'session-a', size: null },
    )
    const frame = { type: 'terminal.status', status: 'connecting', detail: null }
    onFrame?.(frame)
    assert.deepEqual(sender.sent, [['remote:terminal-frame', 'endpoint-a', 'attach-a', frame]])
    sender.fire('did-start-navigation')
    await Promise.resolve()
    const privateId = calls.find(call => call.method === 'attachTerminal')!.args[1]
    assert.notEqual(privateId, 'attach-a')
    assert.deepEqual(calls.at(-1), { method: 'detachTerminal', args: ['endpoint-a', privateId] })
  })

  it('refuses terminal mutation from a renderer that does not own the endpoint attach pair', async () => {
    const owner = new WindowPeersTestSender()
    const other = new WindowPeersTestSender()
    await WindowPeersTest.invoke(
      'remote:terminal-attach',
      owner,
      'endpoint-a',
      'attach-a',
      { sessionId: 'session-a', size: null },
    )
    assert.deepEqual(await WindowPeersTest.invoke(
      'remote:terminal-input',
      other,
      'endpoint-a',
      'attach-a',
      'whoami\r',
    ), {
      ok: false,
      error: 'Remote terminal attach is not owned by this renderer: attach-a',
    })
  })
  it('owns independent view leases per pane and releases every lease on navigation', async () => {
    const one = new WindowPeersTestSender()
    const other = new WindowPeersTestSender()
    const a = await WindowPeersTest.invoke('remote:view-open', one, 'endpoint', 'session')
    const b = await WindowPeersTest.invoke('remote:view-open', one, 'endpoint', 'session')
    if (!a.ok || !a.value.ok || !b.ok || !b.value.ok) throw new Error('No view')
    assert.notEqual(a.value.value.viewId, b.value.value.viewId)
    assert.partialDeepStrictEqual(await WindowPeersTest.invoke('remote:view-close', other, 'endpoint', a.value.value.viewId), { ok: false })
    assert.partialDeepStrictEqual(await WindowPeersTest.invoke('remote:view-detail', one, 'foreign-endpoint', a.value.value.viewId), { ok: false })
    await WindowPeersTest.invoke('remote:view-close', one, 'endpoint', a.value.value.viewId)
    assert.partialDeepStrictEqual(await WindowPeersTest.invoke('remote:view-detail', one, 'endpoint', b.value.value.viewId), { ok: true })
    one.fire('did-start-navigation')
    const closes = calls.filter((call) => call.method === 'sessionView' && (call.args[1] as RemoteSessionViewRequest).operation === 'views.close')
    assert.equal((closes).length, 2)
  })

})

class WindowPeersTest {
  static outbound(
    calls: { method: string; args: unknown[] }[],
    captureFrame: (callback: (frame: unknown) => void) => void,
  ): RemoteOutboundPort {
    return {
      viewEpoch: () => 'epoch',
      sessionView: async (endpoint: string, request: RemoteSessionViewRequest) => {
        calls.push({ method: 'sessionView', args: [endpoint, request] })
        return { ok: true, value: request.operation === 'views.open' ? { viewId: request.body.viewerId, epoch: request.epoch, ...request.body } : null }
      },
      sessionDetail: async () => ({ ok: true, value: {} }),
      snapshot: () => ({
        revision: 1,
        outbound: [{ remoteEndpointId: 'outbound' }],
        inbound: [],
      }),
      execute: (...args: unknown[]) => {
        calls.push({ method: 'execute', args })
        const request = args[1] as { requestId: string; operation: string; operationId?: string }
        return Promise.resolve({
          protocol: 'appjamat-v3-control.v1',
          requestId: request.requestId,
          operation: request.operation,
          operationId: request.operationId ?? null,
          ok: true,
          value: {},
        })
      },
      connectComputer: (...args: unknown[]) => { calls.push({ method: 'connectComputer', args }) },
      releaseConnections: (...args: unknown[]) => {
        calls.push({ method: 'releaseConnections', args })
      },
      sessionReference: (...args: unknown[]) => {
        calls.push({ method: 'sessionReference', args })
        return { ok: true, value: { text: `AppJamatV3 session remote ${String(args[1])}` } }
      },
      selectSession: () => ({ ok: true, value: undefined }),
      disconnectSessions: (...args: unknown[]) => { calls.push({ method: 'disconnectSessions', args }) },
      attachTerminal: (...args: unknown[]) => {
        calls.push({ method: 'attachTerminal', args: args.slice(0, 3) })
        captureFrame(args[3] as (frame: unknown) => void)
        return Promise.resolve({ ok: true, value: { attachId: args[1], sessionId: 'session-a' } })
      },
      terminalInput: (...args: unknown[]) => {
        calls.push({ method: 'terminalInput', args })
        return Promise.resolve({ ok: true, value: {} })
      },
      terminalResize: (...args: unknown[]) => {
        calls.push({ method: 'terminalResize', args })
        return Promise.resolve({ ok: true, value: {} })
      },
      terminalActive: (...args: unknown[]) => {
        calls.push({ method: 'terminalActive', args })
        return Promise.resolve({ ok: true, value: {} })
      },
      detachTerminal: (...args: unknown[]) => {
        calls.push({ method: 'detachTerminal', args })
        return Promise.resolve({ ok: true, value: {} })
      },
    } as unknown as RemoteOutboundPort
  }

  static inbound() {
    return {
      connectionId: 'inbound',
      connectedAt: 1,
      identity: {
        remoteComputerId: 'computer-a',
        remoteEndpointId: 'endpoint-a',
        configIdentity: 'config-a',
        runtimeChannel: 'development' as const,
        displayName: 'Computer A',
      },
      activeSessionIds: [],
    }
  }

  static async invoke<K extends keyof WindowRemoteInvokeMap>(
    channel: K,
    sender: WindowPeersTestSender,
    ...args: unknown[]
  ): Promise<IpcResult<ReturnType<WindowRemoteInvokeMap[K]>>> {
    try { return { ok: true, value: await WindowPeersFixture.current.window(sender).invoke({ method: channel, args } as WindowRemoteCall,
      { signal: new AbortController().signal, pending: () => {} }) as ReturnType<WindowRemoteInvokeMap[K]> } }
    catch (error) { return { ok: false, error: String(error instanceof Error ? error.message : error) } }
  }
}

class WindowPeersTestSender {
  /** What Electron gives every WebContents, and what a hold key is built out of. */
  private static nextId = 0
  readonly id: number
  readonly sent: unknown[][] = []
  private readonly listeners = new Map<string, (() => void)[]>()
  private destroyed = false

  constructor() {
    this.id = ++WindowPeersTestSender.nextId
  }

  on(channel: string, listener: () => void): void {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener])
  }

  fire(channel: string): void {
    if (channel === 'destroyed') this.destroyed = true
    for (const listener of this.listeners.get(channel) ?? []) listener()
  }

  isDestroyed(): boolean { return this.destroyed }

  send(channel: string, ...args: unknown[]): void { this.sent.push([channel, ...args]) }

}


it('keeps equal source view ids on two endpoints owned and released independently', async t => {
  const releaseMedia = mock.fn()
  const source = {
    viewEpoch: () => 'epoch',
    sessionView: mock.fn(async (_endpoint: string, request: RemoteSessionViewRequest) => request.operation === 'views.open'
      ? { ok: true, value: { viewId: 'same', epoch: 'epoch', ...request.body } }
      : { ok: true, value: null }),
    sessionDetail: mock.fn(async (endpoint: string) => ({ ok: true, value: { endpoint } })),
  }
  const fixture = new WindowPeersFixture(source as unknown as RemoteOutboundPort, { snapshot: () => [] },
    { revision: () => 1, acceptsRenderer: () => true, releaseMedia })
  t.after(() => fixture.close())
  const sender = new WindowPeersTestSender()
  await WindowPeersTest.invoke('remote:view-open', sender, 'one', 'session')
  await WindowPeersTest.invoke('remote:view-open', sender, 'two', 'session')
  assert.partialDeepStrictEqual(await WindowPeersTest.invoke('remote:view-detail', sender, 'one', 'same'), { value: { ok: true, value: { endpoint: 'one' } } })
  await WindowPeersTest.invoke('remote:view-close', sender, 'one', 'same')
  assert.ok(releaseMedia.mock.calls.some(call => isDeepStrictEqual(call.arguments, ['one', 'same'])))
  assert.partialDeepStrictEqual(await WindowPeersTest.invoke('remote:view-detail', sender, 'two', 'same'), { value: { ok: true, value: { endpoint: 'two' } } })
})

it('routes every content operation under a current endpoint and window owned view', async t => {
  const calls: { method: string; args: unknown[] }[] = [], source = WindowPeersTest.outbound(calls, () => {})
  const original = source.sessionView
  source.sessionView = async (endpoint, request) => {
    if (request.operation === 'views.open' || request.operation === 'views.close') return original(endpoint, request)
    calls.push({ method: 'content', args: [endpoint, request] })
    return { ok: true, value: { transferId: 'transfer', version: 'version', offset: 0, totalBytes: 1, base64: 'eA==' } }
  }
  const fixture = new WindowPeersFixture(source, { snapshot: () => [] }, { revision: () => 1, acceptsRenderer: () => true })
  t.after(() => fixture.close())
  const sender = new WindowPeersTestSender(), other = new WindowPeersTestSender()
  const opened = await WindowPeersTest.invoke('remote:view-open', sender, 'peer', 'session')
  if (!opened.ok || !opened.value.ok) throw new Error('No view')
  const view = opened.value.value
  for (const operation of ['changes.request', 'changes.page', 'reviews.request', 'reviews.page', 'sidebar.request', 'sidebar.page',
    'tasks.request', 'tasks.page', 'items.open', 'items.request', 'items.page', 'files.request', 'files.page']) {
    const method = ('remote:' + operation.replace('.', '-')) as keyof WindowRemoteInvokeMap
    const body = { marker: operation }
    assert.partialDeepStrictEqual(await WindowPeersTest.invoke(method, sender, 'peer', view.viewId, body), { ok: true, value: { ok: true } })
    assert.partialDeepStrictEqual(calls.at(-1), { method: 'content', args: ['peer', { ...view, operation, body }] })
    assert.partialDeepStrictEqual(await WindowPeersTest.invoke(method, other, 'peer', view.viewId, body), { ok: false })
  }
  assert.equal(calls.filter(call => call.method === 'content').length, 13)
})

it('drops delayed views from a replaced peer epoch and releases only the old view', async t => {
  const calls: { method: string; args: unknown[] }[] = [], source = WindowPeersTest.outbound(calls, () => {})
  let epoch = 'old', finish!: (value: Awaited<ReturnType<RemoteOutboundPort['sessionView']>>) => void
  source.viewEpoch = () => epoch
  const original = source.sessionView
  source.sessionView = (endpoint, request) => request.operation === 'views.open' ? new Promise(resolve => { finish = resolve }) : original(endpoint, request)
  const release = mock.fn(), fixture = new WindowPeersFixture(source, { snapshot: () => [] }, { revision: () => 1, acceptsRenderer: () => true, releaseMedia: release })
  t.after(() => fixture.close())
  const sender = new WindowPeersTestSender(), pending = WindowPeersTest.invoke('remote:view-open', sender, 'peer', 'session')
  epoch = 'new'
  finish({ ok: true, value: { viewId: 'view', epoch: 'old', sessionId: 'session', viewerId: 'viewer' } })
  assert.partialDeepStrictEqual(await pending, { ok: true, value: { ok: false, error: { code: 'unavailable' } } })
  assert.throws(() => fixture.window(sender).authorizeView('peer', 'view'), /not owned/)
  assert.deepEqual(release.mock.calls.map(call => call.arguments), [['peer', 'view']])
  assert.partialDeepStrictEqual(calls.at(-1), { method: 'sessionView', args: ['peer', { operation: 'views.close', epoch: 'old', viewId: 'view' }] })
})

it('does not let cancellation of an older connect release a replacement hold', async t => {
  const calls: { method: string; args: unknown[] }[] = [], source = WindowPeersTest.outbound(calls, () => {})
  const fixture = new WindowPeersFixture(source, { snapshot: () => [] }, { revision: () => 1, acceptsRenderer: () => true })
  t.after(() => fixture.close())
  const sender = new WindowPeersTestSender(), owner = fixture.window(sender), old = new AbortController(), current = new AbortController()
  await owner.invoke({ method: 'remote:connect', args: ['network-settings', 'peer'] }, { signal: old.signal, pending: () => {} })
  await owner.invoke({ method: 'remote:connect', args: ['network-settings', 'peer'] }, { signal: current.signal, pending: () => {} })
  old.abort()
  assert.equal(calls.filter(call => call.method === 'releaseConnections').length, 0)
  current.abort()
  assert.equal(calls.filter(call => call.method === 'releaseConnections').length, 1)
})

it('revokes delayed clipboard work and old frames on attach reuse, while admitting only new private chunks', async t => {
  const calls: { method: string; args: unknown[] }[] = [], frames: ((frame: unknown) => void)[] = []
  const source = WindowPeersTest.outbound(calls, frame => frames.push(frame))
  let signal!: AbortSignal, finish!: (value: Awaited<ReturnType<WindowPeersDependencies['clipboard']>>) => void
  source.terminalPasteFile = async (endpoint, id, chunk) => { calls.push({ method: 'chunk', args: [endpoint, id, chunk] }); return { ok: true, value: { path: 'remote-file' } } }
  const fixture = new WindowPeersFixture(source, { snapshot: () => [] }, { revision: () => 1, acceptsRenderer: () => true,
    clipboard: (_endpoint, _id, lifetime) => { signal = lifetime; return new Promise(resolve => { finish = resolve }) } })
  t.after(() => fixture.close())
  const sender = new WindowPeersTestSender(), owner = fixture.window(sender)
  await WindowPeersTest.invoke('remote:terminal-attach', sender, 'peer', 'reused', { sessionId: 'old', size: null })
  const old = calls.find(call => call.method === 'attachTerminal')!.args[1] as string
  const pending = WindowPeersTest.invoke('remote:terminal-clipboard-paste', sender, 'peer', 'reused')
  await WindowPeersTest.invoke('remote:terminal-detach', sender, 'peer', 'reused')
  await WindowPeersTest.invoke('remote:terminal-attach', sender, 'peer', 'reused', { sessionId: 'new', size: null })
  const current = calls.filter(call => call.method === 'attachTerminal').at(-1)!.args[1] as string
  assert.equal(signal.aborted, true)
  assert.notEqual(current, old)
  const chunk = { uploadId: 'upload', fileName: 'file', size: 1, offset: 0, data: 'eA==' }
  assert.throws(() => owner.pasteFile('peer', old, chunk), /expired/)
  assert.partialDeepStrictEqual(await owner.pasteFile('peer', current, chunk), { ok: true })
  frames[0]!({ type: 'terminal.status', status: 'lost', detail: 'obsolete' })
  assert.deepEqual(sender.sent, [])
  finish({ ok: true, value: { kind: 'text', text: 'old-result' } })
  assert.partialDeepStrictEqual(await pending, { ok: false })
  assert.equal(calls.filter(call => call.method === 'chunk').length, 1)
})

class WindowPeersFixture {
  static current: WindowPeersFixture
  private readonly windows = new Map<WindowPeersTestSender, { owner: WindowPeers; output: ViewerBuffer<WindowTerminalPayload> }>()
  private readonly outbound: RemoteOutboundPort
  private readonly inbound: { snapshot(): unknown[] }
  private readonly deps: { revision(): number; acceptsRenderer(sender: WindowPeersTestSender): boolean; releaseMedia?(endpointId: string, viewId: string, documentId?: string): void; clipboard?: WindowPeersDependencies['clipboard'] }
  constructor(outbound: RemoteOutboundPort, inbound: WindowPeersFixture['inbound'], deps: WindowPeersFixture['deps']) {
    this.outbound = outbound; this.inbound = inbound; this.deps = deps; WindowPeersFixture.current = this
  }
  window(sender: WindowPeersTestSender): WindowPeers {
    const existing = this.windows.get(sender)
    if (existing) return existing.owner
    const output = new ViewerBuffer<WindowTerminalPayload>({
      bytesOf: value => Buffer.byteLength(JSON.stringify(value)),
      send: (value, generation, sequence) => {
        if (value.type !== 'remote-terminal-frame') throw new Error('Unexpected local frame')
        sender.send('remote:terminal-frame', value.endpointId, value.attachId, value.frame)
        output.received(generation, sequence)
      }, truncate: () => owner.truncate(), resume: () => owner.resume(),
    })
    const owner = new WindowPeers('renderer ' + sender.id, this.deps.acceptsRenderer(sender), {
      outbound: () => this.outbound,
      snapshot: () => ({ revision: this.deps.revision(), outbound: this.outbound.snapshot().outbound, inbound: this.inbound.snapshot() as never }),
      clipboard: this.deps.clipboard ?? (async () => ({ ok: true, value: { kind: 'empty' } })),
      releaseMedia: (...args) => this.deps.releaseMedia?.(...args),
    }, output, { span: (_name, run) => run() }, message => { throw new Error(message) }, () => owner.close())
    sender.on('destroyed', () => owner.close()); sender.on('did-start-navigation', () => owner.close())
    this.windows.set(sender, { owner, output })
    return owner
  }
  close(): void { for (const { owner, output } of this.windows.values()) { owner.close(); output.close() } }
}
