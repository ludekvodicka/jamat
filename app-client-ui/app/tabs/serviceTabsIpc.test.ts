import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type { TabTransferLease, TabTransferPayload, WorkspacePanelPresence } from '../../shared/tabTransfer'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import { ServiceTabsIpc } from './serviceTabsIpc'
import type { TabControlBroker } from './tabControlBroker'
import type { TabTransferBroker } from './tabTransferBroker'
import { WorkspacePanelIndex } from './workspacePanelIndex'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

class FakeWindows {
  readonly mainSender = { id: 1 } as unknown as WebContents
  readonly holderSender = { id: 2 } as unknown as WebContents
  readonly otherSender = { id: 3 } as unknown as WebContents
  readonly focused: string[] = []
  readonly published: { windowId: string; channel: string; args: unknown[] }[] = []
  readonly rejected = new Set<WebContents>()
  readonly ready: string[] = []
  readonly created: string[] = []

  windowIdOf(sender: WebContents): string | null {
    if (sender === this.mainSender) return 'main'
    else if (sender === this.holderSender) return 'holder'
    else if (sender === this.otherSender) return 'other'
    else return null
  }

  roleOf(sender: WebContents): 'main' | 'holder' | null {
    const windowId = this.windowIdOf(sender)
    if (windowId === 'main') return 'main'
    else if (windowId === 'holder' || windowId === 'other') return 'holder'
    else if (windowId === null) return null
    else throw new Error(`Unknown fake window: ${windowId}`)
  }

  acceptsRenderer(sender: WebContents): boolean {
    return this.windowIdOf(sender) !== null && !this.rejected.has(sender)
  }

  acceptsWindow(windowId: string): boolean {
    return ['main', 'holder', 'other', ...this.created].includes(windowId)
  }

  focusOrRecreate(windowId: string): void {
    this.focused.push(windowId)
  }

  publishTo(windowId: string, channel: string, ...args: unknown[]): void {
    this.published.push({ windowId, channel, args })
  }

  createHolder(): { windowId: string } {
    const windowId = `created-${this.created.length + 1}`
    this.created.push(windowId)
    return { windowId }
  }

  whenRendererReady(windowId: string): Promise<void> {
    this.ready.push(windowId)
    return Promise.resolve()
  }

  asRegistry(): WorkspaceWindows {
    return this as unknown as WorkspaceWindows
  }
}

class FakeBroker {
  readonly started: { token: string; panel: TabTransferPayload; sourceWindowId: string }[] = []
  readonly prepared: { token: string; targetWindowId: string }[] = []
  readonly committed: { token: string; targetWindowId: string }[] = []
  readonly aborted: { token: string; targetWindowId: string }[] = []
  prepareAnswer: TabTransferLease | null = null

  start(token: string, panel: TabTransferPayload, sourceWindowId: string): void {
    this.started.push({ token, panel, sourceWindowId })
  }

  prepare(token: string, targetWindowId: string): Promise<TabTransferLease | null> {
    this.prepared.push({ token, targetWindowId })
    return Promise.resolve(this.prepareAnswer)
  }

  commit(token: string, targetWindowId: string): void {
    this.committed.push({ token, targetWindowId })
  }

  abort(token: string, targetWindowId: string): void {
    this.aborted.push({ token, targetWindowId })
  }

  asBroker(): TabTransferBroker {
    return this as unknown as TabTransferBroker
  }
}

class FakeControlBroker {
  readonly acknowledgements: { windowId: string; ack: unknown }[] = []

  acknowledge(windowId: string, ack: unknown): void {
    this.acknowledgements.push({ windowId, ack })
  }

  asBroker(): TabControlBroker {
    return this as unknown as TabControlBroker
  }
}

describe('app-client-ui/app/tabs/serviceTabsIpc', () => {
  /*
   * Every one of these mutates the index first and announces second, so a throw from the
   * announcement leaves the two sides disagreeing with nothing to reconcile them. The claim is the
   * worst: the renderer is told its claim failed and drops the panel while the index still names the
   * window as owner, so that session can never be claimed again.
   */
  it('answers the renderer even when the presence announcement throws', async () => {
    presenceFails = true

    const claimed = await invoke(windows.mainSender, 'tabs:claim-panel', panel('probe:1'))

    expect(claimed).toMatchObject({ ok: true, value: { kind: 'granted' } })
    expect(presenceChanges).toBe(1)
  })

  let windows: FakeWindows
  let index: WorkspacePanelIndex
  let broker: FakeBroker
  let controlBroker: FakeControlBroker
  let presenceChanges: number
  let presenceFails: boolean

  function panel(
    panelId: string,
    sessionId: string | null = null,
    presentation: WorkspacePanelPresence['presentation'] = null,
  ): WorkspacePanelPresence {
    return {
      panelId,
      key: sessionId === null ? 'probe' : 'terminal',
      title: panelId,
      params: sessionId === null ? {} : { sessionId },
      sessionId,
      presentation,
    }
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    windows = new FakeWindows()
    index = new WorkspacePanelIndex()
    broker = new FakeBroker()
    controlBroker = new FakeControlBroker()
    presenceChanges = 0
    presenceFails = false
    new ServiceTabsIpc(
      windows.asRegistry(),
      index,
      broker.asBroker(),
      controlBroker.asBroker(),
      () => {
        presenceChanges += 1
        if (presenceFails)
          throw new Error('presence publish failed')
      },
    ).initialize()
  })

  afterEach(() => vi.restoreAllMocks())

  async function invoke(
    sender: WebContents,
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender } as IpcMainInvokeEvent, ...args)
  }

  it('registers every channel it declares', () => {
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceTabsIpc.channelsConst).sort())
  })

  it('routes a tab control acknowledgement with the renderer identity', async () => {
    const ack = {
      requestId: 'request-1',
      result: { kind: 'opened' as const, panelId: 'terminal:session-1' },
    }
    expect(await invoke(windows.holderSender, 'tabs:control-ack', ack))
      .toEqual({ ok: true, value: undefined })
    expect(controlBroker.acknowledgements).toEqual([{ windowId: 'holder', ack }])
  })

  it('grants a new claim and focuses the owner of a duplicate', async () => {
    expect(await invoke(windows.mainSender, 'tabs:claim-panel', panel('probe:1')))
      .toEqual({ ok: true, value: { kind: 'granted' } })

    expect(await invoke(windows.holderSender, 'tabs:claim-panel', panel('probe:1')))
      .toEqual({
        ok: true,
        value: { kind: 'owned', windowId: 'main', panelId: 'probe:1' },
      })
    expect(windows.focused).toEqual(['main'])
    expect(windows.published).toEqual([
      {
        windowId: 'main',
        channel: 'tabs:activate-panel',
        args: ['probe:1', {}, 'probe:1'],
      },
    ])
  })

  it('focuses an existing terminal without replacing its renderer-owned split parameters', async () => {
    const target = { kind: 'local' as const, sessionId: 'session-1' }
    const terminal: WorkspacePanelPresence = {
      panelId: 'terminal:session-1',
      key: 'terminal',
      title: 'Session 001',
      params: TerminalTargetCodec.params(target),
      sessionId: 'session-1',
      presentation: 'session',
    }
    expect(await invoke(windows.holderSender, 'tabs:claim-panel', terminal))
      .toMatchObject({ ok: true, value: { kind: 'granted' } })

    expect(await invoke(windows.mainSender, 'tabs:claim-panel', terminal))
      .toMatchObject({
        ok: true,
        value: { kind: 'owned', windowId: 'holder', panelId: 'terminal:session-1' },
      })
    expect(windows.published).toEqual([{
      windowId: 'holder',
      channel: 'tabs:activate-panel',
      args: ['terminal:session-1'],
    }])
  })

  it('returns a real refusal for an unknown or closing renderer', async () => {
    const unknown = { id: 99 } as unknown as WebContents
    expect(await invoke(unknown, 'tabs:claim-panel', panel('probe:1')))
      .toEqual({ ok: true, value: { kind: 'refused', detail: 'Unknown workspace renderer' } })
    windows.rejected.add(windows.holderSender)
    expect(await invoke(windows.holderSender, 'tabs:claim-panel', panel('probe:2')))
      .toEqual({
        ok: true,
        value: { kind: 'refused', detail: 'The workspace window is closing' },
      })
    expect(index.entries()).toEqual([])
  })

  it('reconciles in arrival order and rejects every panel from a closing renderer', async () => {
    expect(await invoke(windows.mainSender, 'tabs:reconcile-panels', [panel('probe:1')]))
      .toEqual({
        ok: true,
        value: { acceptedPanelIds: ['probe:1'], rejectedPanelIds: [] },
      })
    expect(await invoke(windows.holderSender, 'tabs:reconcile-panels', [
      panel('probe:1'),
      panel('probe:2'),
    ])).toEqual({
      ok: true,
      value: { acceptedPanelIds: ['probe:2'], rejectedPanelIds: ['probe:1'] },
    })

    windows.rejected.add(windows.otherSender)
    expect(await invoke(windows.otherSender, 'tabs:reconcile-panels', [panel('probe:3')]))
      .toEqual({
        ok: true,
        value: { acceptedPanelIds: [], rejectedPanelIds: ['probe:3'] },
      })
  })

  it('releases during teardown and publishes changes to active presence', async () => {
    await invoke(windows.holderSender, 'tabs:claim-panel', panel('probe:1'))
    windows.rejected.add(windows.holderSender)
    expect(await invoke(windows.holderSender, 'tabs:set-active-panel', 'probe:1'))
      .toEqual({ ok: true, value: undefined })
    expect(await invoke(windows.holderSender, 'tabs:release-panel', 'probe:1'))
      .toEqual({ ok: true, value: undefined })

    expect(index.entries()).toEqual([])
    expect(presenceChanges).toBe(3)
  })

  it('routes close and restart events to the panel owners', async () => {
    index.claimOpen('main', panel('regular', 'session-1', 'session'))
    index.claimOpen('holder', panel('plain', 'session-1', 'plain'))

    await invoke(windows.mainSender, 'tabs:close-terminal-panel', 'session-1')
    await invoke(windows.mainSender, 'tabs:publish-terminal-restarted', 'session-1')

    expect(windows.published).toEqual([
      { windowId: 'main', channel: 'tabs:close-panel', args: ['regular'] },
      { windowId: 'holder', channel: 'tabs:close-panel', args: ['plain'] },
      { windowId: 'main', channel: 'tabs:terminal-restarted', args: ['session-1'] },
      { windowId: 'holder', channel: 'tabs:terminal-restarted', args: ['session-1'] },
    ])
  })

  it('routes a remote target only to the window that owns that endpoint session', async () => {
    const target = { kind: 'remote' as const, remoteEndpointId: 'endpoint-a', sessionId: 'session-1' }
    const panelId = 'terminal:remote-a'
    index.claimOpen('holder', {
      panelId,
      key: 'terminal',
      title: 'Remote session',
      params: TerminalTargetCodec.params(target),
      sessionId: null,
      presentation: null,
    })
    const targetKey = TerminalTargetCodec.key(target)

    await invoke(windows.mainSender, 'tabs:close-terminal-panel', targetKey)
    await invoke(windows.mainSender, 'tabs:publish-terminal-restarted', targetKey)

    expect(windows.published).toEqual([
      { windowId: 'holder', channel: 'tabs:close-panel', args: [panelId] },
      { windowId: 'holder', channel: 'tabs:terminal-restarted', args: [targetKey] },
    ])
  })

  it('allows only main to read global sessions or route a close', async () => {
    index.claimOpen('holder', panel('plain', 'session-1', 'plain'))

    expect(await invoke(windows.mainSender, 'tabs:open-session-ids'))
      .toEqual({ ok: true, value: ['session-1'] })
    for (const channel of [
      'tabs:open-session-ids',
      'tabs:close-terminal-panel',
    ] as const)
      expect(await invoke(windows.holderSender, channel, 'session-1'))
        .toEqual({ ok: false, error: 'This tabs operation is main-only' })
  })

  // `session.restart` is a `windowScope: 'any'` command with an accelerator, so a holder runs it
  // like any other window. Refusing the announcement after the restart already happened left
  // every panel of that session attached to a runtime that had just been replaced.
  it('lets a holder announce a restart of a session it draws', async () => {
    index.claimOpen('holder', panel('plain', 'session-1', 'plain'))

    expect(await invoke(windows.holderSender, 'tabs:publish-terminal-restarted', 'session-1'))
      .toEqual({ ok: true, value: undefined })
    expect(windows.published).toContainEqual({
      windowId: 'holder',
      channel: 'tabs:terminal-restarted',
      args: ['session-1'],
    })
  })

  it('routes drag registration and the three transfer phases through the sender window', async () => {
    const payload = panel('probe:1')
    broker.prepareAnswer = { token: 'token-1', panel: payload }

    await invoke(windows.mainSender, 'tabs:drag-started', 'token-1', payload)
    expect(await invoke(windows.holderSender, 'tabs:transfer-prepare', 'token-1'))
      .toEqual({ ok: true, value: broker.prepareAnswer })
    await invoke(windows.holderSender, 'tabs:transfer-commit', 'token-1')
    await invoke(windows.holderSender, 'tabs:transfer-abort', 'token-2')

    expect(broker.started).toEqual([
      { token: 'token-1', panel: payload, sourceWindowId: 'main' },
    ])
    expect(broker.prepared).toEqual([{ token: 'token-1', targetWindowId: 'holder' }])
    expect(broker.committed).toEqual([{ token: 'token-1', targetWindowId: 'holder' }])
    expect(broker.aborted).toEqual([{ token: 'token-2', targetWindowId: 'holder' }])
    expect(presenceChanges).toBe(1)
  })

  it('does not fail commit after the broker mutated ownership when presence publishing fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    presenceFails = true

    expect(await invoke(windows.holderSender, 'tabs:transfer-commit', 'token-1'))
      .toEqual({ ok: true, value: undefined })
    expect(broker.committed).toEqual([{ token: 'token-1', targetWindowId: 'holder' }])
    expect(presenceChanges).toBe(1)
  })

  it('rejects a transfer from an unknown, closing or welcome source', async () => {
    const unknown = { id: 99 } as unknown as WebContents
    expect(await invoke(unknown, 'tabs:drag-started', 'token', panel('probe:1')))
      .toEqual({ ok: false, error: 'Unknown workspace renderer' })
    windows.rejected.add(windows.mainSender)
    expect(await invoke(windows.mainSender, 'tabs:drag-started', 'token', panel('probe:1')))
      .toEqual({ ok: false, error: 'The workspace window is closing: main' })
    windows.rejected.delete(windows.mainSender)
    expect(await invoke(windows.mainSender, 'tabs:drag-started', 'token', {
      ...panel('welcome:{}'),
      key: 'welcome',
    })).toEqual({ ok: false, error: 'The welcome panel cannot be transferred' })
    expect(broker.started).toEqual([])
  })

  it('moves a panel to a new holder only after its renderer is ready', async () => {
    const payload = panel('probe:1')

    expect(await invoke(windows.mainSender, 'tabs:move-panel', payload, { kind: 'newWindow' }))
      .toEqual({ ok: true, value: undefined })

    expect(windows.created).toEqual(['created-1'])
    expect(windows.ready).toEqual(['created-1'])
    expect(broker.started).toHaveLength(1)
    expect(broker.started[0]).toMatchObject({ panel: payload, sourceWindowId: 'main' })
    expect(windows.published).toEqual([
      { windowId: 'created-1', channel: 'tabs:transfer-in', args: [broker.started[0]?.token] },
    ])
  })

  it('does not create a holder for welcome and ignores a self-targeted move', async () => {
    await invoke(windows.mainSender, 'tabs:move-panel', {
      ...panel('welcome:{}'),
      key: 'welcome',
    }, { kind: 'newWindow' })
    await invoke(windows.mainSender, 'tabs:move-panel', panel('probe:1'), {
      kind: 'window',
      windowId: 'main',
    })

    expect(windows.created).toEqual([])
    expect(broker.started).toEqual([])
    expect(windows.focused).toEqual(['main'])
  })
})
