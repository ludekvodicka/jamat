import { act, render, type RenderResult } from '@testing-library/react'

import type { AppClientUiBridge } from '../../../../../../shared/appClientUiIpc'
import type {
  RemoteSettingsInboundPeerDto,
  RemoteSettingsProfileDto,
  RemoteSettingsSaveResult,
  RemoteSettingsSnapshotDto,
} from '../../../../../../shared/remoteSettingsSnapshot'

/** The slice of the bridge these screens touch; the rest of it is not stubbed at all. */
interface RemoteSettingsBridgeParts {
  remoteSettings: AppClientUiBridge['remoteSettings']
  /** The Remote connections screen holds the connections open while it is drawn; see its tab. */
  remote: Pick<AppClientUiBridge['remote'], 'connect' | 'release'>
  clipboard: Pick<AppClientUiBridge['clipboard'], 'writeText'>
  onRemoteChanged: AppClientUiBridge['onRemoteChanged']
}

/** What a test can ask the stubbed bridge about afterwards, and the one push it can make. */
export interface RemoteSettingsBridgeStub {
  /** Every write the screen made, in order, one line each. */
  calls: string[]
  /** Kept apart from `calls`: a hold is a screen being open, not something somebody clicked. */
  holds: string[]
  /**
   * Replaces the document and fires `remote:changed`, which carries nothing. The wait for the
   * reader's coalescing window belongs to the caller, because only it has an `act` to wait inside.
   */
  push: (next: RemoteSettingsSnapshotDto) => void
}

/**
 * One paired computer that is offline and nobody allowed in, on a computer whose listener is up:
 * every Remote connections test starts here and overrides the one fact it is about.
 *
 * The model test and the screen test read the same document, so they share this rather than each
 * carrying a copy of a shape that grows a field per release.
 */
export class RemoteControlSettingsFixtures {
  static profile(overrides: Partial<RemoteSettingsProfileDto> = {}): RemoteSettingsProfileDto {
    return {
      profileId: 'profile-a',
      displayName: 'Office PC',
      remoteComputerId: 'computer-a',
      remoteEndpointId: 'endpoint-a',
      configIdentity: 'jamat-v3',
      runtimeChannel: 'development',
      endpoint: { host: '203.0.113.10', port: 47_150 },
      fingerprint: 'fingerprint-a',
      status: 'offline',
      error: 'ECONNREFUSED 203.0.113.10:47150',
      lastConnectedAt: null,
      nextRetryAt: null,
      applicationVersion: null,
      ...overrides,
    }
  }

  /** One computer that was allowed in, which is the other direction and shares nothing with above. */
  static inboundPeer(
    overrides: Partial<RemoteSettingsInboundPeerDto> = {},
  ): RemoteSettingsInboundPeerDto {
    return {
      remoteComputerId: 'computer-b',
      remoteEndpointId: 'endpoint-b',
      displayName: 'Laptop',
      fingerprint: 'fingerprint-b',
      addedAt: Date.UTC(2026, 8, 1, 8, 0, 0),
      connected: false,
      ...overrides,
    }
  }

  static snapshot(
    overrides: Partial<RemoteSettingsSnapshotDto> = {},
  ): RemoteSettingsSnapshotDto {
    return {
      identity: {
        remoteComputerId: 'computer-here',
        remoteEndpointId: 'endpoint-here',
        displayName: 'This PC',
        fingerprint: 'fingerprint-here',
        configIdentity: 'jamat-v3',
        runtimeChannel: 'development',
      },
      bundleText: '{"schemaVersion":1}',
      listener: {
        configured: { enabled: true, bindHost: '0.0.0.0', port: 47_150, advertisedHost: '10.0.0.2' },
        runtime: { status: 'listening', actualHost: '0.0.0.0', actualPort: 47_150 },
      },
      profiles: [RemoteControlSettingsFixtures.profile()],
      inbound: [],
      sectionDamaged: false,
      ...overrides,
    }
  }

  static installBridge(
    snapshot: RemoteSettingsSnapshotDto = RemoteControlSettingsFixtures.snapshot(),
    answer: RemoteSettingsSaveResult = { ok: true },
  ): RemoteSettingsBridgeStub {
    let current = snapshot
    let notify: (() => void) | null = null
    const calls: string[] = []
    const holds: string[] = []
    const answered = (label: string) => {
      calls.push(label)
      return Promise.resolve({ ok: true as const, value: answer })
    }
    const bridge: RemoteSettingsBridgeParts = {
      remoteSettings: {
        get: () => Promise.resolve({ ok: true as const, value: current }),
        saveListener: (listener) => answered(`saveListener:${JSON.stringify(listener)}`),
        connectPairing: (text) => answered(`connectPairing:${text}`),
        setProfileEndpoint: (profileId, endpoint) =>
          answered(`setProfileEndpoint:${profileId}:${endpoint.host}:${endpoint.port}`),
        retryProfile: (profileId) => answered(`retryProfile:${profileId}`),
        forgetProfile: (profileId) => answered(`forgetProfile:${profileId}`),
        revokeInbound: (remoteComputerId, remoteEndpointId) =>
          answered(`revokeInbound:${remoteComputerId}:${remoteEndpointId}`),
      },
      remote: {
        connect: (reason) => {
          holds.push(`connect:${reason}`)
          return Promise.resolve({ ok: true as const, value: { ok: true as const, value: undefined } })
        },
        release: (reason) => {
          holds.push(`release:${reason}`)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
      },
      clipboard: {
        writeText: (text) => {
          calls.push(`clipboard:${text}`)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
      },
      onRemoteChanged: (callback) => {
        notify = callback
        return () => { notify = null }
      },
    }
    ;(window as unknown as { appClient: RemoteSettingsBridgeParts }).appClient = bridge
    return {
      calls,
      holds,
      push: (next) => {
        current = next
        notify?.()
      },
    }
  }

  /**
   * The three Network screens mount identically: stub the bridge, render, and let the first read
   * land. `push` is here rather than in each test because `remote:changed` carries nothing, so a
   * push costs a read of the whole document and the wait for the reader's coalescing window has to
   * happen inside an `act`.
   */
  static async mount(
    element: React.JSX.Element,
    options: {
      snapshot?: RemoteSettingsSnapshotDto
      answer?: RemoteSettingsSaveResult
    } = {},
  ): Promise<{
    view: RenderResult
    calls: readonly string[]
    holds: readonly string[]
    push: (next: RemoteSettingsSnapshotDto) => Promise<void>
  }> {
    const stub = RemoteControlSettingsFixtures.installBridge(options.snapshot, options.answer)
    const view = render(element)
    await act(async () => Promise.resolve())
    return {
      view,
      calls: stub.calls,
      holds: stub.holds,
      push: async (next: RemoteSettingsSnapshotDto) => {
        await act(async () => {
          stub.push(next)
          await new Promise((resolve) => setTimeout(resolve, 200))
        })
      },
    }
  }

  static clearBridge(): void {
    delete (window as unknown as { appClient?: unknown }).appClient
  }

  /** Scoped to a root, because a paired computer's row carries a Port field of its own. */
  static inputLabelled(root: HTMLElement, label: string): HTMLInputElement {
    const found = [...root.querySelectorAll('label')]
      .find((node) => node.textContent?.startsWith(label))
    const control = found === undefined ? null : root.querySelector(`#${found.htmlFor}`)
    if (!(control instanceof HTMLInputElement))
      throw new Error(`The screen drew no input for ${label}`)
    return control
  }

  static buttonNamed(root: HTMLElement, label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')]
      .find((node) => node.textContent === label)
    if (found === undefined) throw new Error(`The screen drew no ${label} button`)
    return found
  }
}
