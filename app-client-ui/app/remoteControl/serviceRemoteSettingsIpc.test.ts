import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  ConfigOpResult,
  ConfigOpRefusal,
  ConfigSectionSpec,
} from '../../../lib-orchestrator/configStore/configStore.types'
import type {
  RemoteConnectionsSnapshot,
  RemoteInboundConnectionDto,
} from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { RemoteControlPairing } from '../../../lib-orchestrator/remoteControl/remoteControlPairing'
import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import {
  RemoteControlSettings,
  type RemoteControlListenerSettings,
} from '../../shared/remoteControlSettings'
import type {
  RemoteSettingsSaveResult,
  RemoteSettingsSnapshotDto,
} from '../../shared/remoteSettingsSnapshot'
import type { RemoteControlPeerListenAddress } from './remoteControlPeerServer'
import {
  RemoteControlPairingManager,
  type RemoteControlPairingImportResult,
} from './remoteControlPairingManager'
import { RemoteControlSettingsSection } from './remoteControlSettingsSection'
import { RemoteEndpointIdentityStore } from './remoteEndpointIdentityStore'
import { RemotePeerCredentialStore } from './remotePeerCredentialStore'
import {
  RemotePeerListenerManager,
  type RemotePeerListenerServer,
} from './remotePeerListenerManager'
import { RemoteProfileLifecycle } from './remoteProfileLifecycle'
import { ServiceRemoteSettingsIpc } from './serviceRemoteSettingsIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/remoteControl/serviceRemoteSettingsIpc', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * The whole reason this snapshot exists rather than the stores being read from a renderer: what a
   * window may know about pairing is the fingerprint and the PUBLIC bundle, and nothing else. The
   * private key sits one field away in the same file the Allowed-in list is read from, so the claim
   * is measured over the serialized snapshot rather than trusted to the shape of the type.
   */
  it('never carries a private key, a bearer or a token', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.pair(true)
    harness.publishBundle()

    const snapshot = await harness.snapshot()

    // The Allowed-in row is in there, or the scan below is measuring an empty list.
    expect(snapshot.inbound.length).toBe(1)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(harness.privateKey())
    expect(serialized).not.toContain(harness.remoteIdentity.signing.publicKey)
    expect(serialized).not.toMatch(/private|secret|bearer|token|authorization/i)
    // The two things pairing DOES hand around are there, or the screen has nothing to show.
    expect(snapshot.identity.fingerprint).toBe(harness.localFingerprint())
    expect(snapshot.bundleText).toContain(harness.localFingerprint())
  })

  it('composes identity, listener state and one row per paired computer', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    const profile = harness.pair()
    harness.outbound = [{
      remoteEndpointId: profile.remoteEndpointId,
      status: 'connecting',
      diagnosis: {
        lastConnectedAt: 1_700_000_000_000,
        nextRetryAt: 1_700_000_030_000,
        applicationVersion: '2026.08.31.10.00',
      },
    }]

    const snapshot = await harness.snapshot()

    expect(snapshot.identity.remoteEndpointId).toBe(harness.identity.remoteEndpointId)
    expect(snapshot.listener).toEqual({
      configured: RemoteControlSettings.defaultValue().listener,
      runtime: { status: 'disabled' },
    })
    expect(snapshot.profiles).toEqual([{
      profileId: profile.profileId,
      displayName: profile.displayName,
      remoteComputerId: profile.remoteComputerId,
      remoteEndpointId: profile.remoteEndpointId,
      configIdentity: profile.configIdentity,
      runtimeChannel: profile.runtimeChannel,
      endpoint: profile.endpoint,
      fingerprint: profile.pinnedIdentity.fingerprint,
      status: 'connecting',
      error: null,
      // The connector's own diagnosis, carried through untouched: this screen is the only place a
      // computer that is not connected is drawn at all, so it is the only place these are read.
      lastConnectedAt: 1_700_000_000_000,
      nextRetryAt: 1_700_000_030_000,
      applicationVersion: '2026.08.31.10.00',
    }])
    expect(snapshot.sectionDamaged).toBe(false)
    expect(snapshot.bundleText).toBeNull()
  })

  /**
   * A profile the connector has not read yet has no state of its own, and the row still has to say
   * something true. Idle is exactly it: paired, and nothing is asking for it.
   */
  it('draws a profile the connector has not seen as idle', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.pair(true)

    const snapshot = await harness.snapshot()

    expect(snapshot.profiles[0]).toMatchObject({ status: 'idle' })
  })

  /**
   * The Allowed-in list, and the one thing it says that the trust file alone cannot: whether that
   * computer is in here RIGHT NOW. Trust is read at connect and never again, so the dot is the live
   * registry's answer and not the file's.
   */
  it('lists every computer allowed in and lights only the ones connected', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.pair(true)
    harness.allowIn(harness.secondIdentity)
    harness.live = [harness.connection(harness.remoteIdentity)]

    const snapshot = await harness.snapshot()

    expect(snapshot.inbound).toEqual([
      {
        remoteComputerId: harness.remoteIdentity.remoteComputerId,
        remoteEndpointId: harness.remoteIdentity.remoteEndpointId,
        displayName: harness.remoteIdentity.displayName,
        fingerprint: harness.remoteIdentity.signing.fingerprint,
        addedAt: harness.allowedAt(harness.remoteIdentity),
        connected: true,
      },
      {
        remoteComputerId: harness.secondIdentity.remoteComputerId,
        remoteEndpointId: harness.secondIdentity.remoteEndpointId,
        displayName: harness.secondIdentity.displayName,
        fingerprint: harness.secondIdentity.signing.fingerprint,
        addedAt: harness.allowedAt(harness.secondIdentity),
        connected: false,
      },
    ])
  })

  /**
   * The order is the whole test. A peer that was let in yesterday keeps its control of this computer
   * until it next reconnects, so the socket has to go before the file - and the hang-up is recorded
   * with what the trust file held at that moment.
   */
  it('hangs up an allowed-in computer before it takes its trust away', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.pair(true)

    expect(await harness.revokeInbound(harness.remoteIdentity)).toEqual({ ok: true })

    expect(harness.closed).toEqual([{
      remoteComputerId: harness.remoteIdentity.remoteComputerId,
      remoteEndpointId: harness.remoteIdentity.remoteEndpointId,
      trustedAtClose: true,
    }])
    expect(harness.trusted(harness.remoteIdentity)).toBeNull()
    expect((await harness.snapshot()).inbound).toEqual([])
    expect(harness.changes).toBe(1)
    // The outbound half is untouched: being allowed in never said anything about being dialled.
    expect(harness.storedProfiles().length).toBe(1)
  })

  it('binds before it writes, and writes nothing when the bind is refused', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.bindFailure = 'listen EADDRINUSE: address already in use 0.0.0.0:47150'

    expect(await harness.saveListener({ enabled: true }))
      .toMatchObject({ ok: false, code: 'bind-failed' })

    expect(harness.storedListener().enabled).toBe(false)
    expect(harness.listener.runtime()).toMatchObject({ status: 'failed' })
    expect(harness.changes).toBe(0)
  })

  /**
   * The bind succeeded and the file refused it, so the runtime is holding a port the settings do not
   * name. It goes back to what was there before rather than being left ahead of the file.
   */
  it('puts the listener back when the write is refused after the bind', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.saveRefusal = { ok: false, code: 'config-latched', detail: 'the file does not read' }

    expect(await harness.saveListener({ enabled: true, port: 47_151 }))
      .toEqual({ ok: false, code: 'config-refused', detail: 'the file does not read' })

    expect(harness.listener.runtime()).toEqual({ status: 'disabled' })
    expect(harness.binds).toEqual([47_151])
    expect(harness.changes).toBe(0)
  })

  /**
   * The save order's whole point. A CLI pairing import lands while the port is binding, so the
   * section read before the bind no longer holds every profile - and writing it would take the new
   * computer away again.
   */
  it('writes the listener over a freshly read section, not the one it started from', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.gated = true
    const saving = harness.saveListener({ enabled: true, port: 47_151 })
    await harness.waitUntil(() => harness.servers.length === 1)
    const arrived = harness.pair(true)
    harness.releaseBind()

    expect(await saving).toEqual({ ok: true })

    expect(harness.storedListener()).toMatchObject({ enabled: true, port: 47_151 })
    expect(harness.storedProfile(arrived.profileId)).toBeDefined()
    expect(harness.changes).toBe(1)
  })

  it('refuses a save while another one is binding, and once the client is quitting', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.gated = true
    const saving = harness.saveListener({ enabled: true })
    await harness.waitUntil(() => harness.servers.length === 1)

    expect(await harness.saveListener({ enabled: true, port: 47_200 }))
      .toMatchObject({ ok: false, code: 'busy' })

    harness.releaseBind()
    expect(await saving).toEqual({ ok: true })
    harness.listener.beginStop()
    expect(await harness.saveListener({ enabled: true, port: 47_300 }))
      .toMatchObject({ ok: false, code: 'stopping' })
    expect(harness.storedListener().port).toBe(47_150)
  })

  /**
   * A hand-edited section refuses its owner's save, so taking a port for one would be taking it for
   * nothing. The screen is told the same thing through the snapshot and locks its form over it.
   */
  it('refuses a listener save over a damaged section without binding anything', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.damageSection()

    expect(await harness.snapshot()).toMatchObject({ sectionDamaged: true })
    expect(await harness.saveListener({ enabled: true }))
      .toMatchObject({ ok: false, code: 'config-refused' })
    expect(harness.servers.length).toBe(0)
  })

  /** A host or a port the section would not take is refused before the listener is touched. */
  it('refuses a listener the section would not store', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)

    expect(await harness.saveListener({ enabled: true, port: 0 }))
      .toMatchObject({ ok: false, code: 'config-refused' })

    expect(harness.servers.length).toBe(0)
    expect(harness.listener.runtime()).toEqual({ status: 'disabled' })
  })

  it('imports a pasted bundle and trusts that computer with nothing in return', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)

    expect(await harness.connectPairing(harness.bundleText())).toEqual({ ok: true })

    const stored = harness.storedProfiles()[0]
    expect(stored).toMatchObject({ profileId: expect.any(String) })
    expect(harness.addressed).toEqual([])
    expect(harness.trusted(harness.remoteIdentity)).toBeNull()
    expect(harness.reloads).toBe(1)
    expect(harness.changes).toBe(1)
  })

  /**
   * One field, two inputs, and the decision between them is this side's: a pasted bundle is JSON and
   * an address never is. Text that is neither is refused with the sentence that names both, because
   * a person who typed the wrong thing has to be told what the right things are.
   */
  it('sends a typed address to the probe and refuses text that is neither', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    harness.addressOutcome = { ok: true, value: harness.profileValue() }

    expect(await harness.connectPairing(' 203.0.113.10:47150 ')).toEqual({ ok: true })

    expect(harness.addressed).toEqual([{ host: '203.0.113.10', port: 47_150 }])
    expect(harness.reloads).toBe(1)
    expect(harness.changes).toBe(1)

    expect(await harness.connectPairing('[fe80::1]:47150')).toEqual({ ok: true })

    expect(harness.addressed[1]).toEqual({ host: 'fe80::1', port: 47_150 })
    expect(await harness.connectPairing('not json at all')).toEqual({
      ok: false,
      code: 'invalid-bundle',
      detail: 'Paste a pairing bundle or type host:port',
    })
    // A host with no port is refused rather than given one nobody typed.
    expect(await harness.connectPairing('office.lan'))
      .toMatchObject({ ok: false, code: 'invalid-bundle' })
    expect(await harness.connectPairing('office.lan:70000'))
      .toMatchObject({ ok: false, code: 'invalid-bundle' })
    expect(harness.addressed.length).toBe(2)
  })

  /** A `{` that is not a bundle, and an address nothing answered: two refusals, two vocabularies. */
  it('reports what each half of the connect field refused', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)

    expect(await harness.connectPairing('{ not really json'))
      .toMatchObject({ ok: false, code: 'invalid-bundle' })
    expect(await harness.connectPairing('office.lan:47150'))
      .toEqual({ ok: false, code: 'probe-failed', detail: 'nothing answered at that address' })
    expect(harness.reloads).toBe(0)
    expect(harness.changes).toBe(0)
  })

  /**
   * Forget is the outbound half and only that. What that computer may do HERE was granted at this
   * computer's own dialog and is taken back in the Allowed-in list, so it survives the row leaving.
   */
  it('moves an endpoint and forgets a computer without touching inbound trust', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    const profile = harness.pair(true)

    expect(await harness.setEndpoint(profile.profileId, { host: 'moved.lan', port: 47_152 }))
      .toEqual({ ok: true })
    expect(harness.storedProfile(profile.profileId)?.endpoint)
      .toEqual({ host: 'moved.lan', port: 47_152 })

    expect(await harness.forget(profile.profileId)).toEqual({ ok: true })

    expect(harness.storedProfile(profile.profileId)).toBeUndefined()
    expect(harness.trusted(harness.remoteIdentity)).not.toBeNull()
    expect(harness.changes).toBe(2)
  })

  /**
   * The Retry button of a row. It writes nothing and publishes nothing of its own - the dial it asks
   * for reaches the screen through the connector's own change - so all there is to see here is the
   * endpoint the row's profile resolves to, and a refusal when that profile is gone.
   */
  it('asks the connector to dial the endpoint the row names, and refuses a row nothing holds', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)
    const profile = harness.pair()

    expect(await harness.retry(profile.profileId)).toEqual({ ok: true })

    expect(harness.retried).toEqual([profile.remoteEndpointId])
    expect(harness.changes).toBe(0)
    expect(await harness.retry('missing')).toMatchObject({ ok: false, code: 'not-found' })
    expect(harness.retried).toEqual([profile.remoteEndpointId])
  })

  it('answers not-found for a profile nothing holds', async () => {
    const harness = ServiceRemoteSettingsIpcTest.harness(roots)

    expect(await harness.forget('missing')).toMatchObject({ ok: false, code: 'not-found' })
    expect(harness.changes).toBe(0)
  })

  it('registers a handler for every channel it declares', () => {
    ServiceRemoteSettingsIpcTest.harness(roots)

    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceRemoteSettingsIpc.channelsConst).sort())
  })
})

class ServiceRemoteSettingsIpcTest {
  readonly retried: string[] = []
  readonly servers: ServiceRemoteSettingsIpcTestServer[] = []
  readonly binds: number[] = []
  /** Every hang-up, with what the trust file still held at that moment: the order IS the contract. */
  readonly closed: {
    remoteComputerId: string
    remoteEndpointId: string
    trustedAtClose: boolean
  }[] = []
  /** Every address the connect field routed to the probe rather than to the bundle parser. */
  readonly addressed: RemoteControlPeerEndpoint[] = []
  readonly listener: RemotePeerListenerManager
  readonly identity: RemoteControlPeerIdentity
  readonly remoteIdentity: RemoteControlPeerIdentity
  readonly secondIdentity: RemoteControlPeerIdentity
  private readonly pairing: RemoteControlPairingManager
  changes = 0
  reloads = 0
  gated = false
  bindFailure: string | null = null
  saveRefusal: ConfigOpRefusal | null = null
  /** What the probe path answers. The probe itself is the pairing manager's own test's business. */
  addressOutcome: RemoteControlPairingImportResult = {
    ok: false,
    code: 'probe-failed',
    detail: 'nothing answered at that address',
  }
  live: readonly RemoteInboundConnectionDto[] = []
  outbound: readonly {
    remoteEndpointId: string
    status: 'connecting' | 'connected'
    diagnosis?: {
      lastConnectedAt: number | null
      nextRetryAt: number | null
      applicationVersion: string | null
    }
  }[] = []

  private constructor(
    private readonly root: string,
    private readonly store: ConfigStore,
    private readonly credentials: RemotePeerCredentialStore,
    identity: RemoteControlPeerIdentity,
    remoteIdentity: RemoteControlPeerIdentity,
    secondIdentity: RemoteControlPeerIdentity,
  ) {
    this.identity = identity
    this.remoteIdentity = remoteIdentity
    this.secondIdentity = secondIdentity
    this.listener = new RemotePeerListenerManager({
      serverFactory: () => {
        const server = new ServiceRemoteSettingsIpcTestServer(
          () => this.gated,
          () => this.bindFailure,
        )
        this.servers.push(server)
        return server
      },
      onBound: (_advertisedHost, port) => { this.binds.push(port) },
      onChanged: () => undefined,
    })
    this.pairing = new RemoteControlPairingManager(
      store,
      credentials,
      identity,
      join(root, 'bundle.json'),
      () => Promise.resolve(true),
    )
    new ServiceRemoteSettingsIpc({
      // Wrapped rather than replaced: the migration, the damage rule and the exact refusal words all
      // belong to the real store, and only the one failure a test cannot provoke is injected.
      configStore: {
        readSection: <T,>(spec: ConfigSectionSpec<T>): T => store.readSection(spec),
        saveSection: <T,>(spec: ConfigSectionSpec<T>, value: T): ConfigOpResult =>
          this.saveRefusal ?? store.saveSection(spec, value),
        sectionDamage: <T,>(spec: ConfigSectionSpec<T>): ConfigOpRefusal | null =>
          store.sectionDamage(spec),
      },
      identity,
      listener: this.listener,
      lifecycle: new RemoteProfileLifecycle({
        configStore: store,
        connections: { reloadProfiles: () => { this.reloads += 1 } },
      }),
      // The bundle half is the real manager; the address half is answered here, because what the
      // probe does with a real socket is that class's own test.
      pairing: {
        bundle: () => this.pairing.bundle(),
        import: (input) => this.pairing.import(input),
        importFromAddress: (endpoint) => {
          this.addressed.push(endpoint)
          return Promise.resolve(this.addressOutcome)
        },
      },
      credentials,
      inbound: {
        snapshot: () => this.live,
        closeEndpoint: (remoteComputerId, remoteEndpointId) => {
          this.closed.push({
            remoteComputerId,
            remoteEndpointId,
            // Read AT the hang-up: a false here means the file went first and the socket second.
            trustedAtClose:
              credentials.trustedInbound(remoteComputerId, remoteEndpointId) !== null,
          })
        },
      },
      connections: {
        snapshot: () => this.connectionsSnapshot(),
        reloadProfiles: () => { this.reloads += 1 },
        retryNow: (remoteEndpointId) => { this.retried.push(remoteEndpointId) },
      },
      onChanged: () => { this.changes += 1 },
    }).initialize()
  }

  static harness(roots: string[]): ServiceRemoteSettingsIpcTest {
    ipcMainMock.handlers.clear()
    const root = ServiceRemoteSettingsIpcTest.root(roots, 'local')
    const remoteRoot = ServiceRemoteSettingsIpcTest.root(roots, 'remote')
    const secondRoot = ServiceRemoteSettingsIpcTest.root(roots, 'second')
    return new ServiceRemoteSettingsIpcTest(
      root,
      ConfigStore.load(root, {
        snapshotsDirectory: join(root, 'snapshots'),
        report: () => undefined,
      }),
      ServiceRemoteSettingsIpcTest.credentials(root, 'local'),
      ServiceRemoteSettingsIpcTest.identity(root, 'local'),
      ServiceRemoteSettingsIpcTest.identity(remoteRoot, 'remote'),
      ServiceRemoteSettingsIpcTest.identity(secondRoot, 'second'),
    )
  }

  snapshot(): Promise<RemoteSettingsSnapshotDto> {
    return this.invoke('remoteSettings:get') as Promise<RemoteSettingsSnapshotDto>
  }

  saveListener(
    overrides: Partial<RemoteControlListenerSettings>,
  ): Promise<RemoteSettingsSaveResult> {
    return this.command(
      'remoteSettings:listener-save',
      { ...RemoteControlSettings.defaultValue().listener, ...overrides },
    )
  }

  connectPairing(text: string): Promise<RemoteSettingsSaveResult> {
    return this.command('remoteSettings:pairing-connect', text)
  }

  revokeInbound(identity: RemoteControlPeerIdentity): Promise<RemoteSettingsSaveResult> {
    return this.command(
      'remoteSettings:inbound-revoke',
      identity.remoteComputerId,
      identity.remoteEndpointId,
    )
  }

  setEndpoint(
    profileId: string,
    endpoint: { host: string; port: number },
  ): Promise<RemoteSettingsSaveResult> {
    return this.command('remoteSettings:profile-endpoint', profileId, endpoint)
  }

  retry(profileId: string): Promise<RemoteSettingsSaveResult> {
    return this.command('remoteSettings:profile-retry', profileId)
  }

  forget(profileId: string): Promise<RemoteSettingsSaveResult> {
    return this.command('remoteSettings:profile-forget', profileId)
  }

  /**
   * One paired computer, in the two stores that are now independent: the profile this computer
   * dials with, and - only when `allowIn` - the trust a person granted at the dialog.
   */
  pair(allowIn = false): RemoteControlPeerProfile {
    const profile = RemoteControlPairing.profile(
      RemoteControlPairing.bundle(this.remoteIdentity, { host: 'remote.lan', port: 47_151 }),
      { profileId: 'profile-remote' },
    )
    const saved = this.store.saveSection(
      RemoteControlSettingsSection.spec,
      RemoteControlSettings.withProfile(
        this.store.readSection(RemoteControlSettingsSection.spec),
        profile,
      ),
    )
    if (!saved.ok) throw new Error(`The test could not store its profile: ${saved.detail}`)
    if (allowIn) this.credentials.trustInbound(this.remoteIdentity)
    return profile
  }

  /** What the Allow dialog leaves behind: trust for that computer, and no profile of any kind. */
  allowIn(identity: RemoteControlPeerIdentity): void {
    this.credentials.trustInbound(identity)
  }

  allowedAt(identity: RemoteControlPeerIdentity): number {
    const found = this.credentials.inboundPeers().find((peer) =>
      peer.identity.remoteComputerId === identity.remoteComputerId
      && peer.identity.remoteEndpointId === identity.remoteEndpointId)
    if (found === undefined) throw new Error('The test allowed nobody in')
    return found.addedAt
  }

  /** That computer, connected right now, as the live registry would report it. */
  connection(identity: RemoteControlPeerIdentity): RemoteInboundConnectionDto {
    return {
      connectionId: `connection-${identity.remoteEndpointId}`,
      connectedAt: 1_700_000_000_000,
      identity: {
        remoteComputerId: identity.remoteComputerId,
        remoteEndpointId: identity.remoteEndpointId,
        configIdentity: identity.configIdentity,
        runtimeChannel: identity.runtimeChannel,
        displayName: identity.displayName,
      },
      activeSessionIds: [],
    }
  }

  /** The profile a probe would have ended at; what it holds is the pairing manager's own test. */
  profileValue(): RemoteControlPeerProfile {
    return RemoteControlPairing.profile(
      RemoteControlPairing.bundle(this.remoteIdentity, { host: '203.0.113.10', port: 47_150 }),
      { profileId: 'profile-probed' },
    )
  }

  /** What another computer would be handed to pair with this one. */
  bundleText(): string {
    return JSON.stringify(
      RemoteControlPairing.bundle(this.remoteIdentity, { host: 'remote.lan', port: 47_151 }),
    )
  }

  publishBundle(): void {
    this.pairing.publish({ host: '203.0.113.10', port: 47_150 })
  }

  privateKey(): string {
    const document = JSON.parse(readFileSync(join(this.root, 'credentials.json'), 'utf8')) as {
      privateKey: string
    }
    return document.privateKey
  }

  localFingerprint(): string {
    return this.identity.signing.fingerprint
  }

  trusted(identity: RemoteControlPeerIdentity): RemoteControlPeerIdentity | null {
    return this.credentials.trustedInbound(identity.remoteComputerId, identity.remoteEndpointId)
  }

  storedListener(): RemoteControlListenerSettings {
    return this.store.readSection(RemoteControlSettingsSection.spec).listener
  }

  storedProfiles(): readonly RemoteControlPeerProfile[] {
    return this.store.readSection(RemoteControlSettingsSection.spec).profiles
  }

  storedProfile(profileId: string): RemoteControlPeerProfile | undefined {
    return this.storedProfiles().find((candidate) => candidate.profileId === profileId)
  }

  /** A hand edit its owner cannot read, which is what the damaged flag and the latch are about. */
  damageSection(): void {
    writeFileSync(
      join(this.root, 'config.json'),
      JSON.stringify({ schemaVersion: 1, remoteControl: { listener: 'yes please', profiles: [] } }),
      'utf8',
    )
  }

  releaseBind(): void {
    for (const server of this.servers) server.release()
  }

  async waitUntil(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('The remote settings test timed out waiting for the listener')
  }

  private connectionsSnapshot(): RemoteConnectionsSnapshot {
    return {
      revision: 1,
      outbound: this.outbound.map((endpoint) => ({
        profileId: 'profile-remote',
        remoteComputerId: this.remoteIdentity.remoteComputerId,
        remoteEndpointId: endpoint.remoteEndpointId,
        configIdentity: this.remoteIdentity.configIdentity,
        runtimeChannel: this.remoteIdentity.runtimeChannel,
        displayName: this.remoteIdentity.displayName,
        endpoint: { host: 'remote.lan', port: 47_151 },
        status: endpoint.status,
        error: null,
        lastConnectedAt: endpoint.diagnosis?.lastConnectedAt ?? null,
        nextRetryAt: endpoint.diagnosis?.nextRetryAt ?? null,
        applicationVersion: endpoint.diagnosis?.applicationVersion ?? null,
        optionalOperations: null,
        connectionId: null,
        sessions: null,
      })),
      inbound: [],
    }
  }

  private command(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<RemoteSettingsSaveResult> {
    return this.invoke(channel, ...args) as Promise<RemoteSettingsSaveResult>
  }

  private async invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    const answer = await handler({} as IpcMainInvokeEvent, ...args) as
      { ok: true; value: unknown } | { ok: false; error: string }
    if (!answer.ok) throw new Error(answer.error)
    return answer.value
  }

  private static root(roots: string[], name: string): string {
    const root = mkdtempSync(join(tmpdir(), `jamat-v3-remote-settings-${name}-`))
    roots.push(root)
    return root
  }

  private static credentials(root: string, name: string): RemotePeerCredentialStore {
    return RemotePeerCredentialStore.loadOrCreate(
      join(root, 'credentials.json'),
      join(root, 'machine.json'),
      {
        computerId: () => `computer-${name}`,
        displayName: () => `Computer ${name}`,
        keyPair: () => RemoteControlPeerKeys.generateSigningKeyPair(),
      },
    )
  }

  private static identity(root: string, name: string): RemoteControlPeerIdentity {
    const credentials = ServiceRemoteSettingsIpcTest.credentials(root, name)
    return RemoteEndpointIdentityStore.loadOrCreate(
      join(root, 'endpoint.json'),
      credentials.machineIdentity(),
      `config-${name}`,
      'development',
      () => `endpoint-${name}`,
    ).identity(credentials.machineIdentity())
  }
}

class ServiceRemoteSettingsIpcTestServer implements RemotePeerListenerServer {
  private open: (() => void) | null = null

  constructor(
    private readonly gated: () => boolean,
    private readonly failure: () => string | null,
  ) {}

  async start(host: string, port: number): Promise<RemoteControlPeerListenAddress> {
    if (this.gated()) await new Promise<void>((resolve) => { this.open = resolve })
    const failure = this.failure()
    if (failure !== null) throw new Error(failure)
    return { host, port }
  }

  release(): void {
    this.open?.()
  }

  beginStop(): void {
    // Nothing is bound in a test, so quitting is only the latch the manager sets on itself.
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }
}
