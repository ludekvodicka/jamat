import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlPeerApplicationMessage } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
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

  /*
   * Two windows on the same screen are two holds, so one closing its card cannot hang up the other
   * one's connection. The key carries the window and the reason for exactly that reason.
   */
  it('holds and releases per window and per reason', async () => {
    const one = new ServiceRemoteControlIpcTestSender()
    const two = new ServiceRemoteControlIpcTestSender()
    await ServiceRemoteControlIpcTest.invoke('remote:hold', one, 'network-settings')
    await ServiceRemoteControlIpcTest.invoke('remote:hold', two, 'network-settings')
    await ServiceRemoteControlIpcTest.invoke('remote:release', one, 'network-settings')

    expect(calls.filter((call) => call.method.endsWith('Connections')))
      .toEqual([
        { method: 'holdConnections', args: [`renderer ${one.id} network-settings`] },
        { method: 'holdConnections', args: [`renderer ${two.id} network-settings`] },
        { method: 'releaseConnections', args: [`renderer ${one.id} network-settings`] },
      ])
  })

  /*
   * A window that dies without releasing would otherwise keep every paired computer dialled for the
   * life of the process, which is the state dialling on demand exists to end.
   */
  it('releases every hold a window held when that window dies', async () => {
    const sender = new ServiceRemoteControlIpcTestSender()
    await ServiceRemoteControlIpcTest.invoke('remote:hold', sender, 'launcher-computers')
    await ServiceRemoteControlIpcTest.invoke('remote:hold', sender, 'network-settings')
    calls.length = 0

    sender.fire('destroyed')

    expect(calls.map((call) => call.args[0]).sort()).toEqual([
      `renderer ${sender.id} launcher-computers`,
      `renderer ${sender.id} network-settings`,
    ])
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

    const requests = calls.filter((call) => call.method === 'execute').map((call) => call.args[1])
    expect(requests).toMatchObject([
      { operation: 'projects.list', body: { categoryId: 'nodejs', sort: 'recent' } },
      { operation: 'agents.describe', body: {} },
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
})

class ServiceRemoteControlIpcTest {
  static outbound(
    calls: { method: string; args: unknown[] }[],
    captureFrame: (callback: (frame: unknown) => void) => void,
  ): RemoteConnectionsManager {
    return {
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
      holdConnections: (...args: unknown[]) => { calls.push({ method: 'holdConnections', args }) },
      releaseConnections: (...args: unknown[]) => {
        calls.push({ method: 'releaseConnections', args })
      },
      sessionReference: (...args: unknown[]) => {
        calls.push({ method: 'sessionReference', args })
        return { ok: true, value: { text: `AppJamatV3 session remote ${String(args[1])}` } }
      },
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

  static async invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    sender: ServiceRemoteControlIpcTestSender,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender: sender.asSender() } as IpcMainInvokeEvent, ...args)
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
