import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type {
  RemarkableDependencyStatus,
  RemarkableRenderTarget,
  RemarkableResult,
} from '../../shared/remarkableApi.types'
import type { RemarkableSettingsValue } from '../../shared/remarkableSettings'
import type { RemarkableManager } from './remarkableManager'
import { ServiceRemarkableIpc } from './serviceRemarkableIpc'
import type { RemarkableCredentialStore } from './storage/remarkableCredentialStore'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      electronMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/remarkable/serviceRemarkableIpc', () => {
  const settingsConst: RemarkableSettingsValue = {
    host: '10.11.99.1',
    fingerprint: `SHA256:${'a'.repeat(43)}`,
    timeoutMilliseconds: 180_000,
  }
  const readyConst: RemarkableDependencyStatus = {
    kind: 'ready',
    bundleId: 'bundle-1',
    nodeVersion: '22.23.2',
    cliVersion: '0.3.0',
  }
  let sender: FakeWebContents & WebContents
  let secondSender: FakeWebContents & WebContents
  let rejected: FakeWebContents & WebContents
  let stored: RemarkableSettingsValue
  let saveAnswer: ConfigOpResult
  let configCalls: { method: string; args: unknown[] }[]
  let credentialCalls: { method: string; args: unknown[] }[]
  let managerCalls: { method: string; args: unknown[] }[]
  let service: ServiceRemarkableIpc

  beforeEach(() => {
    electronMock.handlers.clear()
    sender = new FakeWebContents() as FakeWebContents & WebContents
    secondSender = new FakeWebContents() as FakeWebContents & WebContents
    rejected = new FakeWebContents() as FakeWebContents & WebContents
    stored = settingsConst
    saveAnswer = { ok: true }
    configCalls = []
    credentialCalls = []
    managerCalls = []
    service = new ServiceRemarkableIpc(
      managerUnderTest(),
      configStoreUnderTest(),
      credentialStoreUnderTest(),
      (value) => value === sender
        ? 'workspace-1'
        : value === secondSender ? 'workspace-2' : null,
    )
    service.initialize()
  })

  it('registers exactly all sixteen channels it declares', () => {
    expect(Object.keys(ServiceRemarkableIpc.channelsConst)).toHaveLength(16)
    expect([...electronMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceRemarkableIpc.channelsConst).sort())
  })

  it('fails initialization when one of its declared channels was not registered', () => {
    const internals = new ServiceRemarkableIpc(
      managerUnderTest(),
      configStoreUnderTest(),
      credentialStoreUnderTest(),
      () => null,
    ) as unknown as {
      assertComplete(channels: typeof ServiceRemarkableIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceRemarkableIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('reads and saves settings without exposing the password', async () => {
    expect(await invoke('remarkable:settings-get', sender)).toEqual({
      ok: true,
      value: { value: settingsConst, passwordConfigured: true },
    })
    const changed = { ...settingsConst, timeoutMilliseconds: 60_000 }
    expect(await invoke('remarkable:settings-save', sender, changed)).toEqual({
      ok: true,
      value: { ok: true, value: undefined },
    })
    expect(stored).toEqual(changed)
    expect(credentialCalls).toContainEqual({
      method: 'configuredFor',
      args: [settingsConst.host],
    })
  })

  it('maps every config refusal to a renderer-safe reMarkable result', async () => {
    const refusals = [
      ['config-latched', 'invalid-operation'],
      ['section-damaged', 'invalid-operation'],
      ['invalid-section', 'settings-incomplete'],
    ] as const
    for (const [storeCode, wireCode] of refusals) {
      saveAnswer = { ok: false, code: storeCode, detail: `refused ${storeCode}` }
      expect(await invoke('remarkable:settings-save', sender, settingsConst)).toEqual({
        ok: true,
        value: {
          ok: false,
          code: wireCode,
          detail: `refused ${storeCode}`,
          retryable: false,
        },
      })
    }
  })

  it('passes a password only into secure storage and never returns it in data or errors', async () => {
    const password = 'secret-value-that-must-not-return'
    const response = await invoke('remarkable:password-set', sender, settingsConst.host, password)

    expect(credentialCalls).toContainEqual({
      method: 'replace',
      args: [settingsConst.host, password],
    })
    expect(JSON.stringify(response)).not.toContain(password)
    expect(JSON.stringify(await invoke(
      'remarkable:password-set',
      rejected,
      settingsConst.host,
      password,
    )))
      .not.toContain(password)
  })

  it('requires a saved host before accepting a password and clears credentials explicitly', async () => {
    stored = { timeoutMilliseconds: 180_000 }
    expect(await invoke('remarkable:password-set', sender, settingsConst.host, 'password'))
      .toMatchObject({
      ok: true,
      value: { ok: false, code: 'settings-incomplete' },
    })
    expect(credentialCalls.filter((call) => call.method === 'replace')).toEqual([])

    stored = settingsConst
    expect(await invoke('remarkable:password-clear', sender, settingsConst.host)).toEqual({
      ok: true,
      value: { ok: true, value: undefined },
    })
    expect(credentialCalls).toContainEqual({ method: 'clear', args: [settingsConst.host] })
  })

  it('refuses stale password actions after another window changes the saved host', async () => {
    stored = { ...settingsConst, host: '10.11.99.2' }

    expect(await invoke(
      'remarkable:password-set',
      sender,
      settingsConst.host,
      'private-value',
    )).toMatchObject({ ok: true, value: { ok: false, code: 'invalid-operation' } })
    expect(await invoke('remarkable:password-clear', sender, settingsConst.host))
      .toMatchObject({ ok: true, value: { ok: false, code: 'invalid-operation' } })
    expect(credentialCalls).toEqual([])
  })

  it('forwards each machine and operation action with the trusted owner only', async () => {
    const target: RemarkableRenderTarget = { kind: 'listed-page', pageId: 'page-2' }

    await invoke('remarkable:fingerprint-detect', sender)
    await invoke('remarkable:connection-test', sender)
    await invoke('remarkable:dependencies-status', sender)
    await invoke('remarkable:dependencies-install', sender)
    await invoke('remarkable:operation-start', sender, 's-1')
    await invoke('remarkable:operation-pages', sender, 'operation-1')
    await invoke('remarkable:operation-render', sender, 'operation-1', target)
    await invoke('remarkable:operation-release', sender, 'operation-1')

    expect(managerCalls).toEqual([
      { method: 'detectFingerprint', args: ['workspace-1'] },
      { method: 'testConnection', args: ['workspace-1'] },
      { method: 'dependenciesStatus', args: [] },
      { method: 'installDependencies', args: ['workspace-1'] },
      { method: 'startOperation', args: ['workspace-1', 's-1'] },
      { method: 'listOpenDocument', args: ['workspace-1', 'operation-1'] },
      { method: 'render', args: ['workspace-1', 'operation-1', target] },
      { method: 'release', args: ['workspace-1', 'operation-1'] },
    ])
  })

  it('rejects every channel before an unknown renderer reaches config, credentials or manager', async () => {
    const channels = Object.keys(ServiceRemarkableIpc.channelsConst) as
      (keyof AppClientUiIpcInvokeMap)[]
    configCalls = []

    for (const channel of channels)
      expect(await invoke(channel, rejected, 'secret', { kind: 'current' }), channel)
        .toEqual({ ok: false, error: 'reMarkable request came from an unknown workspace' })

    expect(managerCalls).toEqual([])
    expect(configCalls).toEqual([])
    expect(credentialCalls).toEqual([])
  })

  it('releases one owner on renderer destruction or main-frame navigation', async () => {
    await invoke('remarkable:operation-start', sender)
    await invoke('remarkable:operation-start', sender)
    expect(sender.listeners.get('destroyed')).toHaveLength(1)
    expect(sender.listeners.get('did-start-navigation')).toHaveLength(1)
    sender.emit('destroyed')

    await invoke('remarkable:operation-start', secondSender)
    secondSender.emit('did-start-navigation', {}, 'https://example.test', false, false)
    secondSender.emit('did-start-navigation', {}, 'https://example.test#same', true, true)
    secondSender.emit('did-start-navigation', {}, 'https://example.test', false, true)

    await vi.waitFor(() => expect(managerCalls.filter((call) => call.method === 'releaseOwner'))
      .toEqual([
        { method: 'releaseOwner', args: ['workspace-1'] },
        { method: 'releaseOwner', args: ['workspace-2'] },
      ]))
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    source: WebContents,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = electronMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return await handler({ sender: source } as IpcMainInvokeEvent, ...args)
  }

  function configStoreUnderTest(): Pick<ConfigStore, 'readSection' | 'saveSection'> {
    return {
      readSection: (spec) => {
        configCalls.push({ method: 'readSection', args: [spec] })
        return stored
      },
      saveSection: (spec, value) => {
        configCalls.push({ method: 'saveSection', args: [spec, value] })
        stored = value as RemarkableSettingsValue
        return saveAnswer
      },
    } as Pick<ConfigStore, 'readSection' | 'saveSection'>
  }

  function credentialStoreUnderTest(): Pick<
    RemarkableCredentialStore,
    'clear' | 'configuredFor' | 'replace'
  > {
    return {
      configuredFor: (host) => {
        credentialCalls.push({ method: 'configuredFor', args: [host] })
        return true
      },
      replace: (host, password) => {
        credentialCalls.push({ method: 'replace', args: [host, password] })
        return Promise.resolve({
          ok: false,
          code: 'credential-unavailable',
          detail: 'Secure storage refused the password',
          retryable: false,
        })
      },
      clear: (host) => {
        credentialCalls.push({ method: 'clear', args: [host] })
        return Promise.resolve({ ok: true, value: undefined })
      },
    }
  }

  function managerUnderTest(): RemarkableManager {
    const record = <T>(method: string, value: T) => (...args: unknown[]): Promise<T> => {
      managerCalls.push({ method, args })
      return Promise.resolve(value)
    }
    const success: RemarkableResult = { ok: true, value: undefined }
    return {
      dependenciesStatus: record('dependenciesStatus', readyConst),
      installDependencies: record('installDependencies', { ok: true, value: readyConst }),
      detectFingerprint: record('detectFingerprint', {
        ok: true,
        value: { host: settingsConst.host as string, fingerprint: settingsConst.fingerprint as string },
      }),
      testConnection: record('testConnection', success),
      startOperation: record('startOperation', { ok: true, value: { operationId: 'operation-1' } }),
      listOpenDocument: record('listOpenDocument', {
        ok: false,
        code: 'nothing-open',
        detail: 'Nothing is open',
        retryable: false,
      }),
      render: record('render', success),
      release: record('release', undefined),
      releaseOwner: record('releaseOwner', undefined),
    } as unknown as RemarkableManager
  }
})

class FakeWebContents {
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  on(event: string, listener: (...args: unknown[]) => void): void {
    const current = this.listeners.get(event) ?? []
    current.push(listener)
    this.listeners.set(event, current)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}
