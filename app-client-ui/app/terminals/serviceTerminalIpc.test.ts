import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type {
  TerminalAttachResult,
  TerminalFrame,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceTerminalIpc } from './serviceTerminalIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  clipboard: '',
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
  clipboard: {
    writeText: (text: string) => { ipcMainMock.clipboard = text },
    readText: () => ipcMainMock.clipboard,
  },
}))

/** A window as this service sees one: an identity, and the two ways it can lose its renderer. */
class FakeSender {
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  readonly sent: unknown[][] = []
  destroyed = false

  on(channel: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener])
  }

  countOf(channel: string): number {
    return this.listeners.get(channel)?.length ?? 0
  }

  /** Electron hands `did-start-navigation` four arguments, the fourth of which is `isMainFrame`. */
  fire(channel: string, ...args: unknown[]): void {
    if (channel === 'destroyed') this.destroyed = true
    for (const listener of this.listeners.get(channel) ?? []) listener(...args)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, ...args])
  }

  asSender(): WebContents {
    return this as unknown as WebContents
  }
}

describe('app-client-ui/app/terminals/serviceTerminalIpc', () => {
  const calls: { method: string; args: unknown[] }[] = []
  let answer: TerminalAttachResult
  let attachError: Error | null
  let detachError: Error | null
  let rejectedSenders: Set<WebContents>
  let service: ServiceTerminalIpc

  function recordingManager(): SessionManager {
    const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }) }
    return {
      terminalAttach: (...args: unknown[]) => {
        calls.push({ method: 'terminalAttach', args })
        if (attachError) throw attachError
        return answer
      },
      terminalInput: record('terminalInput'),
      terminalResize: record('terminalResize'),
      terminalSetGeometryActive: record('terminalSetGeometryActive'),
      terminalDetach: (...args: unknown[]) => {
        calls.push({ method: 'terminalDetach', args })
        if (detachError) throw detachError
      },
      terminalDetachAll: record('terminalDetachAll'),
    } as unknown as SessionManager
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    ipcMainMock.clipboard = ''
    calls.length = 0
    answer = { ok: true }
    attachError = null
    detachError = null
    rejectedSenders = new Set()
    service = new ServiceTerminalIpc(
      recordingManager(),
      (sender) => !rejectedSenders.has(sender),
    )
    service.initialize()
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    sender: FakeSender,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender: sender.asSender() } as IpcMainInvokeEvent, ...args)
  }

  it('registers a handler for every channel it declares', () => {
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceTerminalIpc.channelsConst).sort())
  })

  it('forwards each channel to the manager with the arguments it was given', async () => {
    const sender = new FakeSender()
    const spec = { sessionId: 'session-1', size: { cols: 100, rows: 30 } }
    await invoke('terminal:attach', sender, 'a1', spec)
    await invoke('terminal:input', sender, 'a1', 'ls\r')
    await invoke('terminal:resize', sender, 'a1', 120, 40)
    await invoke('terminal:detach', sender, 'a1')

    expect(calls[0]).toMatchObject({
      method: 'terminalAttach',
      args: ['a1', spec, { source: 'local' }],
    })
    expect(calls.slice(1)).toEqual([
      { method: 'terminalInput', args: ['a1', 'ls\r'] },
      { method: 'terminalResize', args: ['a1', 120, 40] },
      { method: 'terminalDetach', args: ['a1'] },
    ])
  })

  it('carries a refusal through as data rather than as a failed channel', async () => {
    answer = { ok: false, code: 'not-live', detail: 'session session-1 has no live runtime' }
    const sender = new FakeSender()
    expect(await invoke('terminal:attach', sender, 'a1', { sessionId: 'session-1', size: null }))
      .toEqual({ ok: true, value: answer })
  })

  it('routes a frame only to the renderer that owns the attach', async () => {
    const owner = new FakeSender()
    const other = new FakeSender()
    const frame = { type: 'terminal.status', status: 'connecting', detail: null } as const
    await invoke('terminal:attach', owner, 'a1', { sessionId: 'session-1', size: null })
    await invoke('terminal:attach', other, 'b1', { sessionId: 'session-2', size: null })
    const ownerPort = calls[0]?.args[2] as { onFrame(frame: TerminalFrame): void }

    ownerPort.onFrame(frame)

    expect(owner.sent).toEqual([['terminal:frame', 'a1', frame]])
    expect(other.sent).toEqual([])

    await invoke('terminal:detach', owner, 'a1')
    ownerPort.onFrame(frame)
    expect(owner.sent).toEqual([['terminal:frame', 'a1', frame]])
  })

  it('rejects input, resize and detach from a renderer that does not own the attach', async () => {
    const owner = new FakeSender()
    const other = new FakeSender()
    await invoke('terminal:attach', owner, 'a1', { sessionId: 'session-1', size: null })
    calls.length = 0

    expect(await invoke('terminal:input', other, 'a1', 'whoami\r')).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(await invoke('terminal:resize', other, 'a1', 120, 40)).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(await invoke('terminal:detach', other, 'a1')).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(calls).toEqual([])
  })

  it('reads and writes the clipboard for the renderer that owns the attach', async () => {
    const owner = new FakeSender()
    await invoke('terminal:attach', owner, 'a1', { sessionId: 'session-1', size: null })

    expect(await invoke('terminal:clipboard-write', owner, 'a1', 'selected text'))
      .toEqual({ ok: true, value: true })
    expect(await invoke('terminal:clipboard-read', owner, 'a1'))
      .toEqual({ ok: true, value: 'selected text' })
  })

  // The narrowing the two channels exist for: the clipboard is the user's, so it answers a window
  // that holds this terminal and nothing else in the renderer.
  it('refuses the clipboard to a renderer that does not own the attach', async () => {
    const owner = new FakeSender()
    const other = new FakeSender()
    await invoke('terminal:attach', owner, 'a1', { sessionId: 'session-1', size: null })
    ipcMainMock.clipboard = 'not yours'

    expect(await invoke('terminal:clipboard-read', other, 'a1')).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(await invoke('terminal:clipboard-write', other, 'a1', 'overwritten')).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(ipcMainMock.clipboard).toBe('not yours')
  })

  /*
   * Handing an attach's geometry away is an ownership decision like writing bytes into it, and it
   * arrives on a channel of its own. A renderer that did not take the attach may not say the tab in
   * front of somebody else has stopped being looked at.
   */
  it('refuses the geometry hand-over to a renderer that does not own the attach', async () => {
    const owner = new FakeSender()
    const other = new FakeSender()
    await invoke('terminal:attach', owner, 'a1', { sessionId: 'session-1', size: null })

    expect(await invoke('terminal:active', other, 'a1', false)).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(calls.filter((call) => call.method === 'terminalSetGeometryActive')).toEqual([])

    expect(await invoke('terminal:active', owner, 'a1', false)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(calls.filter((call) => call.method === 'terminalSetGeometryActive'))
      .toEqual([{ method: 'terminalSetGeometryActive', args: ['a1', false] }])
  })

  it('refuses a second owner for the same attach id', async () => {
    const owner = new FakeSender()
    const other = new FakeSender()
    await invoke('terminal:attach', owner, 'a1', { sessionId: 'session-1', size: null })

    expect(await invoke('terminal:attach', other, 'a1', {
      sessionId: 'session-2',
      size: null,
    })).toEqual({ ok: false, error: 'Attach id already claimed: a1' })
    expect(calls.filter((call) => call.method === 'terminalAttach')).toHaveLength(1)
  })

  it('refuses a new attach from a closing renderer', async () => {
    const sender = new FakeSender()
    rejectedSenders.add(sender.asSender())

    expect(await invoke('terminal:attach', sender, 'a1', {
      sessionId: 'session-1',
      size: null,
    })).toEqual({ ok: false, error: 'The workspace window is closing' })
    expect(calls).toEqual([])
  })

  it('releases a reservation after the manager refuses an attach', async () => {
    const first = new FakeSender()
    const second = new FakeSender()
    answer = { ok: false, code: 'host-unreachable', detail: 'no Host descriptor is published' }
    await invoke('terminal:attach', first, 'a1', { sessionId: 'session-1', size: null })
    answer = { ok: true }

    expect(await invoke('terminal:attach', second, 'a1', {
      sessionId: 'session-2',
      size: null,
    })).toEqual({ ok: true, value: { ok: true } })
  })

  it('releases a reservation after the manager throws during attach', async () => {
    const first = new FakeSender()
    const second = new FakeSender()
    attachError = new Error('attach failed')
    expect(await invoke('terminal:attach', first, 'a1', {
      sessionId: 'session-1',
      size: null,
    })).toEqual({ ok: false, error: 'attach failed' })
    attachError = null

    expect(await invoke('terminal:attach', second, 'a1', {
      sessionId: 'session-2',
      size: null,
    })).toEqual({ ok: true, value: { ok: true } })
  })

  it('releases ownership even when the manager throws during detach', async () => {
    const first = new FakeSender()
    const second = new FakeSender()
    await invoke('terminal:attach', first, 'a1', { sessionId: 'session-1', size: null })
    detachError = new Error('detach failed')
    expect(await invoke('terminal:detach', first, 'a1'))
      .toEqual({ ok: false, error: 'detach failed' })
    detachError = null

    expect(await invoke('terminal:attach', second, 'a1', {
      sessionId: 'session-2',
      size: null,
    })).toEqual({ ok: true, value: { ok: true } })
  })

  /**
   * The reason this service holds any state at all. A window that reloads never says goodbye, the
   * Host allows sixty-four sockets, and every reload during development would otherwise leak one per
   * open terminal until the next attach was refused.
   */
  it('detaches everything a window held when its renderer goes, and nobody else\'s', async () => {
    const window = new FakeSender()
    const other = new FakeSender()
    await invoke('terminal:attach', window, 'a1', { sessionId: 'session-1', size: null })
    await invoke('terminal:attach', window, 'a2', { sessionId: 'session-2', size: null })
    await invoke('terminal:attach', other, 'b1', { sessionId: 'session-3', size: null })

    window.fire('destroyed')
    expect(calls.filter((call) => call.method === 'terminalDetachAll'))
      .toEqual([{ method: 'terminalDetachAll', args: [['a1', 'a2']] }])

    other.fire('did-start-navigation')
    expect(calls.filter((call) => call.method === 'terminalDetachAll').at(-1))
      .toEqual({ method: 'terminalDetachAll', args: [['b1']] })
  })

  it('drops frames after navigation and lets a later renderer reuse every released id', async () => {
    const first = new FakeSender()
    const second = new FakeSender()
    const frame = { type: 'terminal.status', status: 'lost', detail: 'gone' } as const
    await invoke('terminal:attach', first, 'a1', { sessionId: 'session-1', size: null })
    first.fire('did-start-navigation')

    service.publishFrame('a1', frame)
    expect(first.sent).toEqual([])
    expect(await invoke('terminal:attach', second, 'a1', {
      sessionId: 'session-2',
      size: null,
    })).toEqual({ ok: true, value: { ok: true } })
  })

  // A reload navigates away from the document that asked, which is the case a close never covers.
  it('watches both ways a window can lose its renderer, and wires each of them once', async () => {
    const sender = new FakeSender()
    await invoke('terminal:attach', sender, 'a1', { sessionId: 'session-1', size: null })
    await invoke('terminal:attach', sender, 'a2', { sessionId: 'session-1', size: null })

    expect(sender.countOf('destroyed')).toBe(1)
    expect(sender.countOf('did-start-navigation')).toBe(1)
  })

  // What the terminal menu asks instead of believing a session id from the renderer.
  it('answers who owns an attach and which session it is showing', async () => {
    const owner = new FakeSender()
    const other = new FakeSender()
    await invoke('terminal:attach', owner, 'a1', { sessionId: 'session-1', size: null })

    expect(service.ownsAttach(owner.asSender(), 'a1')).toBe(true)
    expect(service.ownsAttach(other.asSender(), 'a1')).toBe(false)
    expect(service.ownsAttach(owner.asSender(), 'unknown')).toBe(false)
    expect(service.sessionOfAttach('a1')).toBe('session-1')
    expect(service.sessionOfAttach('unknown')).toBe(null)
  })

  // A forgotten entry here is a WebContents nothing ever drops, so both ways out clear it.
  it('forgets which session an attach was showing once it is released', async () => {
    const sender = new FakeSender()
    await invoke('terminal:attach', sender, 'a1', { sessionId: 'session-1', size: null })
    await invoke('terminal:attach', sender, 'a2', { sessionId: 'session-2', size: null })

    await invoke('terminal:detach', sender, 'a1')
    expect(service.sessionOfAttach('a1')).toBe(null)
    expect(service.sessionOfAttach('a2')).toBe('session-2')

    sender.fire('destroyed')
    expect(service.sessionOfAttach('a2')).toBe(null)
  })

  it('forgets an attach that was detached, so a later teardown asks for nothing', async () => {
    const sender = new FakeSender()
    await invoke('terminal:attach', sender, 'a1', { sessionId: 'session-1', size: null })
    await invoke('terminal:detach', sender, 'a1')
    calls.length = 0

    sender.fire('destroyed')
    expect(calls).toEqual([])
  })

  // A refused attach holds no socket, so remembering it would only mean detaching something that
  // never existed when the window goes.
  it('remembers only an attach that was accepted', async () => {
    answer = { ok: false, code: 'host-unreachable', detail: 'no Host descriptor is published' }
    const sender = new FakeSender()
    await invoke('terminal:attach', sender, 'a1', { sessionId: 'session-1', size: null })
    calls.length = 0

    sender.fire('destroyed')
    expect(calls).toEqual([])
  })
})
