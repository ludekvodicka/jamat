import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AppClientUiInvokeArgs,
  AppClientUiInvokeResult,
  IpcResult,
} from '../../shared/appClientUiIpc'
import type { AutolauncherResult, AutolauncherSnapshot } from '../../shared/autolauncher'
import { AutolauncherManager } from './autolauncherManager'
import { ServiceAutolauncherIpc } from './serviceAutolauncherIpc'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      electronMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/autolauncher/serviceAutolauncherIpc', () => {
  const acceptedSender = { id: 1 } as WebContents
  const rejectedSender = { id: 2 } as WebContents
  const snapshot: AutolauncherSnapshot = {
    currentTarget: { recipe: null, process: null, availability: { state: 'invalid', path: '' }, warning: null },
    installedTarget: null,
    supported: true,
    target: {
      configDir: 'C:/Users/Alex/.jamat-v3', configIdentity: 'alex-profile',
      runtimeChannel: 'production', mode: 'executable', path: 'C:/Jamat/Jamat.exe',
    },
    installed: true, installedForThisProfile: true, installedConfigDir: 'C:/Users/Alex/.jamat-v3',
    running: true, connectionReady: true, launcherUrl: 'http://198.51.100.20:3511',
    operation: 'idle', problem: null,
  }

  function harness() {
    const unexpected = (): never => { throw new Error('An IPC forwarding test must not run Windows setup or pairing') }
    const manager = new AutolauncherManager(snapshot.target, 'unused-ipc-test-directory', true,
      { install: unexpected, disable: unexpected }, { pair: unexpected, probe: unexpected }, unexpected)
    const inspect = vi.spyOn(manager, 'inspect').mockResolvedValue(snapshot.currentTarget)
    const get = vi.spyOn(manager, 'get').mockResolvedValue(snapshot)
    const enable = vi.spyOn(manager, 'enable').mockResolvedValue({ ok: true, snapshot })
    const disable = vi.spyOn(manager, 'disable').mockResolvedValue({ ok: true, snapshot })
    const acceptsRenderer = vi.fn((sender: WebContents) => sender === acceptedSender)
    new ServiceAutolauncherIpc(manager, acceptsRenderer).initialize()
    return { get, enable, disable, inspect, acceptsRenderer }
  }

  async function invoke<K extends keyof typeof ServiceAutolauncherIpc.channelsConst>(
    channel: K, sender: WebContents, ...args: AppClientUiInvokeArgs<K>
  ): Promise<IpcResult<AppClientUiInvokeResult<K>>> {
    const handler = electronMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender }, ...args) as Promise<IpcResult<AppClientUiInvokeResult<K>>>
  }

  beforeEach(() => electronMock.handlers.clear())
  afterEach(() => vi.restoreAllMocks())

  it('registers exactly the declared channels', () => {
    harness()
    expect([...electronMock.handlers.keys()].sort()).toEqual([
      'autolauncher:disable', 'autolauncher:enable', 'autolauncher:get', 'autolauncher:inspect',
    ])
    expect(Object.keys(ServiceAutolauncherIpc.channelsConst).sort())
      .toEqual([...electronMock.handlers.keys()].sort())
  })

  it('checks the accepted sender before reading or changing the manager and wraps each result', async () => {
    const { get, enable, disable, acceptsRenderer } = harness()
    const invitation = '  opaque-invitation  '

    const status: IpcResult<AutolauncherSnapshot> = await invoke('autolauncher:get', acceptedSender)
    const enabled: IpcResult<AutolauncherResult> = await invoke('autolauncher:enable', acceptedSender, invitation)
    const disabled: IpcResult<AutolauncherResult> = await invoke('autolauncher:disable', acceptedSender)

    expect(status).toEqual({ ok: true, value: snapshot })
    expect(enabled).toEqual({ ok: true, value: { ok: true, snapshot } })
    expect(disabled).toEqual({ ok: true, value: { ok: true, snapshot } })
    expect(get).toHaveBeenCalledExactlyOnceWith()
    expect(enable).toHaveBeenCalledExactlyOnceWith(invitation, undefined)
    expect(disable).toHaveBeenCalledExactlyOnceWith()
    expect(acceptsRenderer.mock.calls).toEqual([[acceptedSender], [acceptedSender], [acceptedSender]])
    expect(acceptsRenderer.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0])
    expect(acceptsRenderer.mock.invocationCallOrder[1]).toBeLessThan(enable.mock.invocationCallOrder[0])
    expect(acceptsRenderer.mock.invocationCallOrder[2]).toBeLessThan(disable.mock.invocationCallOrder[0])
  })

  it('forwards null to reuse pairing and preserves a domain refusal inside the IPC envelope', async () => {
    const { enable } = harness()
    enable.mockResolvedValue({ ok: false, problem: 'Windows permission was cancelled.' })

    expect(await invoke('autolauncher:enable', acceptedSender, null)).toEqual({
      ok: true, value: { ok: false, problem: 'Windows permission was cancelled.' },
    })
    expect(enable).toHaveBeenCalledExactlyOnceWith(null, undefined)
  })

  it('rejects every channel before calling the manager for an unaccepted renderer', async () => {
    const { get, enable, disable, inspect, acceptsRenderer } = harness()
    const answers = [
      await invoke('autolauncher:get', rejectedSender),
      await invoke('autolauncher:enable', rejectedSender, 'opaque-invitation'),
      await invoke('autolauncher:disable', rejectedSender),
      await invoke('autolauncher:inspect', rejectedSender, { kind: 'development', repositoryRoot: 'C:/checkout' }),
    ]

    for (const answer of answers)
      expect(answer).toEqual({ ok: false, error: 'Only a Jamat settings window can configure the launcher.' })
    expect(acceptsRenderer.mock.calls).toEqual([[rejectedSender], [rejectedSender], [rejectedSender], [rejectedSender]])
    expect(get).not.toHaveBeenCalled()
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('forwards the selected recipe and confirmation without changing them', async () => {
    const { inspect, enable } = harness()
    const recipe = { kind: 'development' as const, repositoryRoot: 'C:/checkout' }
    const selection = { recipe, temporaryPathConfirmed: true }
    expect(await invoke('autolauncher:inspect', acceptedSender, recipe)).toEqual({ ok: true, value: snapshot.currentTarget })
    await invoke('autolauncher:enable', acceptedSender, null, selection)
    expect(inspect).toHaveBeenCalledExactlyOnceWith(recipe)
    expect(enable).toHaveBeenCalledExactlyOnceWith(null, selection)
  })

  it('returns manager rejection as a failed IPC envelope instead of rejecting the request', async () => {
    const { get, disable } = harness()
    get.mockRejectedValueOnce(new Error('Status unavailable'))
    disable.mockRejectedValueOnce(new Error('Setup unavailable'))

    expect(await invoke('autolauncher:get', acceptedSender)).toEqual({ ok: false, error: 'Status unavailable' })
    expect(await invoke('autolauncher:disable', acceptedSender)).toEqual({ ok: false, error: 'Setup unavailable' })
  })
})
