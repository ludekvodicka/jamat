import type { RemoteSessionViewRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlRequestUnion } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerApplicationMessage } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { AppClientUiIpcInvokeMap, IpcResult } from '../../shared/appClientUiIpc'
import type { RemoteControlInboundRegistry } from './remoteControlInboundRegistry'
import type { RemoteConnectionsManager } from './remoteConnectionsManager'
import { ServiceRemoteControlIpc } from './serviceRemoteControlIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/remoteControl/serviceRemoteControlIpc', () => {
  const calls: { method: string; args: unknown[] }[] = []
  let service: ServiceRemoteControlIpc
  let onFrame: ((frame: unknown) => void) | null

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    calls.length = 0
    onFrame = null
    service = new ServiceRemoteControlIpc(
      ServiceRemoteControlIpcTest.outbound(calls, (callback) => { onFrame = callback }),
      { snapshot: () => [ServiceRemoteControlIpcTest.inbound()] } as unknown as RemoteControlInboundRegistry,
      {
        revision: () => 9,
        acceptsRenderer: () => true,
        requestId: () => 'request-id',
        operationId: () => 'operation-id',
      },
    )
    service.initialize()
  })

  it('registers every channel and combines outbound and inbound without credentials', async () => {
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceRemoteControlIpc.channelsConst).sort())
    const sender = new ServiceRemoteControlIpcTestSender()
    const answer = await ServiceRemoteControlIpcTest.invoke('remote:snapshot', sender)
    expect(answer).toMatchObject({
      ok: true,
      value: { revision: 9, outbound: [{ remoteEndpointId: 'outbound' }], inbound: [{ connectionId: 'inbound' }] },
    })
    const serialized = JSON.stringify(answer)
    expect(serialized).not.toContain('publicKey')
    expect(serialized).not.toContain('privateKey')
    expect(serialized).not.toContain('token')
  })

  it('preserves source command operation IDs and admits no approval through the generic command channel', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()
    const command = { operation: 'sessions.fork' as const, operationId: 'one-fork', body: { session: { kind: 'sessionId' as const, sessionId: 'source' } } }
    await ServiceRemoteControlIpcTest.invoke('remote:session-command', sender, 'endpoint-a', command)
    expect(calls).toContainEqual({ method: 'execute', args: ['endpoint-a', expect.objectContaining(command)] })
    const answer = await ServiceRemoteControlIpcTest.invoke('remote:session-command', sender, 'endpoint-a', {
      ...command, operation: 'sessions.finishWorktree', body: { ...command.body, choice: 'commit', confirmWorking: true },
    } as never)
    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('not admitted') })
    expect(calls.filter((call) => call.method === 'execute')).toHaveLength(1)
  })

  /*
   * Two windows on the same screen are two holds, so one closing its card cannot hang up the other
   * one's connection. The key carries the window and the reason for exactly that reason.
   */
  it('holds and releases per window and per reason', async () => {
    const one = new ServiceRemoteControlIpcTestSender()
    const two = new ServiceRemoteControlIpcTestSender()
    await ServiceRemoteControlIpcTest.invoke('remote:connect', one, 'network-settings', 'target-endpoint')
    await ServiceRemoteControlIpcTest.invoke('remote:connect', two, 'network-settings', 'target-endpoint')
    await ServiceRemoteControlIpcTest.invoke('remote:release', one, 'network-settings')

    expect(calls.filter((call) => ['connectComputer', 'releaseConnections'].includes(call.method)))
      .toEqual([
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
    const sender = new ServiceRemoteControlIpcTestSender()
    await ServiceRemoteControlIpcTest.invoke('remote:connect', sender, 'launcher-computers', 'target-endpoint')
    await ServiceRemoteControlIpcTest.invoke('remote:connect', sender, 'network-settings', 'target-endpoint')
    calls.length = 0

    sender.fire('destroyed')

    expect(calls.map((call) => call.args[0]).sort()).toEqual([
      `renderer ${sender.id} launcher-computers`,
      `renderer ${sender.id} network-settings`,
    ])
  })

  it('refuses worktree creation before sending to a peer without setup views', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()
    const answer = await ServiceRemoteControlIpcTest.invoke('remote:sessions-create', sender, 'outbound',
      { kind: 'shell', directory: { mode: 'default' }, worktree: { slug: 'child' } }, 'child-create')
    expect(answer).toMatchObject({ ok: true, value: { ok: false, error: { code: 'unavailable' } } })
    expect(calls.filter((call) => call.method === 'execute')).toEqual([])
  })

  it('builds exact semantic requests for create, reopen and finalize', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()
    await ServiceRemoteControlIpcTest.invoke(
      'remote:sessions-create',
      sender,
      'endpoint-a',
      { kind: 'shell', directory: { mode: 'default' } },
      'operation-id',
    )
    await ServiceRemoteControlIpcTest.invoke(
      'remote:sessions-reopen',
      sender,
      'endpoint-a',
      'session-a',
    )
    await ServiceRemoteControlIpcTest.invoke(
      'remote:sessions-finalize',
      sender,
      'endpoint-a',
      'session-a',
    )
    const requests = calls.filter((call) => call.method === 'execute')
      .map((call) => call.args[1] as RemoteControlPeerApplicationMessage)
    expect(requests).toMatchObject([
      { operation: 'sessions.create', operationId: 'operation-id' },
      { operation: 'sessions.reopen', body: { session: { sessionId: 'session-a' } } },
      { operation: 'sessions.finalize', body: { session: { sessionId: 'session-a' } } },
    ])
  })

  /** An older target refuses an unknown key with the whole request, so a press nobody agreed on sends none. */
  it('carries the agreed hash on a finalize only when the overlay sends one', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()

    await ServiceRemoteControlIpcTest.invoke('remote:sessions-finalize', sender, 'endpoint-a', 'session-a')
    await ServiceRemoteControlIpcTest.invoke(
      'remote:sessions-finalize', sender, 'endpoint-a', 'session-a', 'hash-1')

    const bodies = calls.filter((call) => call.method === 'execute')
      .map((call) => (call.args[1] as RemoteControlRequestUnion).body)
    expect(bodies).toEqual([
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
    const sender = new ServiceRemoteControlIpcTestSender()
    const spec = { kind: 'shell', directory: { mode: 'default' } }

    await ServiceRemoteControlIpcTest.invoke(
      'remote:sessions-create', sender, 'endpoint-a', spec, 'intent-7')
    await ServiceRemoteControlIpcTest.invoke(
      'remote:sessions-create', sender, 'endpoint-a', spec, 'intent-7')

    const requests = calls.filter((call) => call.method === 'execute')
      .map((call) => call.args[1] as RemoteControlPeerApplicationMessage)
    expect(requests).toMatchObject([
      { operation: 'sessions.create', operationId: 'intent-7' },
      { operation: 'sessions.create', operationId: 'intent-7' },
    ])
  })

  /**
   * The far side refuses an operationId on an operation that does not mutate, and refuses the whole
   * request for it. Both reads here shipped with one until the remote-app smoke drove them over a
   * real socket and got `invalid-request` back, so the ABSENCE is what is pinned.
   */
  it('asks the paired computer for its own catalog and its own agents, with no operation id', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()

    await ServiceRemoteControlIpcTest.invoke(
      'remote:projects-list', sender, 'endpoint-a', { categoryId: 'nodejs', sort: 'recent' })
    await ServiceRemoteControlIpcTest.invoke('remote:agents-describe', sender, 'endpoint-a')
    await ServiceRemoteControlIpcTest.invoke('remote:accounts-list', sender, 'endpoint-a')

    const requests = calls.filter((call) => call.method === 'execute').map((call) => call.args[1])
    expect(requests).toMatchObject([
      { operation: 'projects.list', body: { categoryId: 'nodejs', sort: 'recent' } },
      { operation: 'agents.describe', body: {} },
      { operation: 'accounts.list', body: {} },
    ])
    expect(requests.every((request) =>
      !Object.hasOwn(request as Record<string, unknown>, 'operationId'))).toBe(true)
  })

  /**
   * The one remote channel that sends nothing over the wire: what the paired computer already pushed
   * is what the block is made of, so the manager answers on its own and `execute` is never reached.
   */
  it('answers the reference from what is held rather than by asking the other computer', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()

    const answer = await ServiceRemoteControlIpcTest.invoke(
      'remote:sessions-reference',
      sender,
      'endpoint-a',
      'session-a',
    )

    expect(answer).toEqual({
      ok: true,
      value: { ok: true, value: { text: 'AppJamatV3 session remote session-a' } },
    })
    expect(calls).toEqual([{ method: 'sessionReference', args: ['endpoint-a', 'session-a'] }])
  })

  it('routes terminal frames only to the owning renderer and cleans up on navigation', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()
    await ServiceRemoteControlIpcTest.invoke(
      'remote:terminal-attach',
      sender,
      'endpoint-a',
      'attach-a',
      { sessionId: 'session-a', size: null },
    )
    const frame = { type: 'terminal.status', status: 'connecting', detail: null }
    onFrame?.(frame)
    expect(sender.sent).toEqual([['remote:terminal-frame', 'endpoint-a', 'attach-a', frame]])
    sender.fire('did-start-navigation')
    await Promise.resolve()
    expect(calls.at(-1)).toEqual({ method: 'detachTerminal', args: ['endpoint-a', 'attach-a'] })
  })

  it('refuses terminal mutation from a renderer that does not own the endpoint attach pair', async () => {
    const owner = new ServiceRemoteControlIpcTestSender()
    const other = new ServiceRemoteControlIpcTestSender()
    await ServiceRemoteControlIpcTest.invoke(
      'remote:terminal-attach',
      owner,
      'endpoint-a',
      'attach-a',
      { sessionId: 'session-a', size: null },
    )
    expect(await ServiceRemoteControlIpcTest.invoke(
      'remote:terminal-input',
      other,
      'endpoint-a',
      'attach-a',
      'whoami\r',
    )).toEqual({
      ok: false,
      error: 'Remote terminal attach is not owned by this renderer: attach-a',
    })
  })
  it('owns independent view leases per pane and releases every lease on navigation', async () => {
    const one = new ServiceRemoteControlIpcTestSender()
    const other = new ServiceRemoteControlIpcTestSender()
    const a = await ServiceRemoteControlIpcTest.invoke('remote:view-open', one, 'endpoint', 'session')
    const b = await ServiceRemoteControlIpcTest.invoke('remote:view-open', one, 'endpoint', 'session')
    if (!a.ok || !a.value.ok || !b.ok || !b.value.ok) throw new Error('No view')
    expect(a.value.value.viewId).not.toBe(b.value.value.viewId)
    expect(await ServiceRemoteControlIpcTest.invoke('remote:view-close', other, 'endpoint', a.value.value.viewId)).toMatchObject({ ok: false })
    expect(await ServiceRemoteControlIpcTest.invoke('remote:view-detail', one, 'foreign-endpoint', a.value.value.viewId)).toMatchObject({ ok: false })
    await ServiceRemoteControlIpcTest.invoke('remote:view-close', one, 'endpoint', a.value.value.viewId)
    expect(await ServiceRemoteControlIpcTest.invoke('remote:view-detail', one, 'endpoint', b.value.value.viewId)).toMatchObject({ ok: true })
    one.fire('did-start-navigation')
    const closes = calls.filter((call) => call.method === 'sessionView' && (call.args[1] as RemoteSessionViewRequest).operation === 'views.close')
    expect(closes).toHaveLength(2)
  })

})

class ServiceRemoteControlIpcTest {
  static outbound(
    calls: { method: string; args: unknown[] }[],
    captureFrame: (callback: (frame: unknown) => void) => void,
  ): RemoteConnectionsManager {
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
    } as unknown as RemoteConnectionsManager
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

  static async invoke<K extends keyof AppClientUiIpcInvokeMap>(
    channel: K,
    sender: ServiceRemoteControlIpcTestSender,
    ...args: unknown[]
  ): Promise<IpcResult<ReturnType<AppClientUiIpcInvokeMap[K]>>> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return await handler({ sender: sender.asSender() } as IpcMainInvokeEvent, ...args) as IpcResult<ReturnType<AppClientUiIpcInvokeMap[K]>>
  }
}

class ServiceRemoteControlIpcTestSender {
  /** What Electron gives every WebContents, and what a hold key is built out of. */
  private static nextId = 0
  readonly id: number
  readonly sent: unknown[][] = []
  private readonly listeners = new Map<string, (() => void)[]>()
  private destroyed = false

  constructor() {
    this.id = ++ServiceRemoteControlIpcTestSender.nextId
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

  asSender(): WebContents { return this as unknown as WebContents }
}


it('keeps equal source view ids on two endpoints owned and released independently', async () => {
  const releaseMedia = vi.fn()
  const source = {
    viewEpoch: () => 'epoch',
    sessionView: vi.fn(async (_endpoint: string, request: RemoteSessionViewRequest) => request.operation === 'views.open'
      ? { ok: true, value: { viewId: 'same', epoch: 'epoch', ...request.body } }
      : { ok: true, value: null }),
    sessionDetail: vi.fn(async (endpoint: string) => ({ ok: true, value: { endpoint } })),
  }
  new ServiceRemoteControlIpc(source as unknown as RemoteConnectionsManager, {} as RemoteControlInboundRegistry,
    { revision: () => 1, acceptsRenderer: () => true, releaseMedia }).initialize()
  const sender = new ServiceRemoteControlIpcTestSender()
  await ServiceRemoteControlIpcTest.invoke('remote:view-open', sender, 'one', 'session')
  await ServiceRemoteControlIpcTest.invoke('remote:view-open', sender, 'two', 'session')
  expect(await ServiceRemoteControlIpcTest.invoke('remote:view-detail', sender, 'one', 'same')).toMatchObject({ value: { ok: true, value: { endpoint: 'one' } } })
  await ServiceRemoteControlIpcTest.invoke('remote:view-close', sender, 'one', 'same')
  expect(releaseMedia).toHaveBeenCalledWith('one', 'same')
  expect(await ServiceRemoteControlIpcTest.invoke('remote:view-detail', sender, 'two', 'same')).toMatchObject({ value: { ok: true, value: { endpoint: 'two' } } })
})
