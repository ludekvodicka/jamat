import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteOutboundEndpointDto } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { ErrorText } from '../../shared/errorText'
import {
  RemoteControlSettings,
  type RemoteControlListenerSettings,
} from '../../shared/remoteControlSettings'
import type {
  RemoteSettingsInboundPeerDto,
  RemoteSettingsProfileDto,
  RemoteSettingsSaveResult,
  RemoteSettingsSnapshotDto,
} from '../../shared/remoteSettingsSnapshot'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { RemoteConnectionsManager } from './remoteConnectionsManager'
import type { RemoteControlInboundRegistry } from './remoteControlInboundRegistry'
import type {
  RemoteControlPairingImportResult,
  RemoteControlPairingManager,
} from './remoteControlPairingManager'
import { RemoteControlSettingsSection } from './remoteControlSettingsSection'
import type { RemotePeerCredentialStore } from './remotePeerCredentialStore'
import type {
  RemoteListenerApplyResult,
  RemotePeerListenerManager,
} from './remotePeerListenerManager'
import type { RemoteProfileLifecycle, RemoteProfileSaveResult } from './remoteProfileLifecycle'

export interface ServiceRemoteSettingsIpcDeps {
  configStore: Pick<ConfigStore, 'readSection' | 'saveSection' | 'sectionDamage'>
  /** This computer's peer identity; only its fingerprint and names reach a renderer. */
  identity: RemoteControlPeerIdentity
  listener: Pick<RemotePeerListenerManager, 'apply' | 'runtime'>
  lifecycle: Pick<RemoteProfileLifecycle, 'setEndpoint' | 'forget'>
  pairing: Pick<RemoteControlPairingManager, 'import' | 'importFromAddress' | 'bundle'>
  credentials: Pick<RemotePeerCredentialStore, 'inboundPeers' | 'revokeInbound'>
  /** The live inbound connections: what the Allowed-in list's dot reads, and what Revoke hangs up. */
  inbound: Pick<RemoteControlInboundRegistry, 'snapshot' | 'closeEndpoint'>
  connections: Pick<RemoteConnectionsManager, 'snapshot' | 'reloadProfiles' | 'retryNow'>
  onChanged(): void
}

/**
 * The Remote Control settings surface, and the reason it is its own service rather than more of
 * `ServiceRemoteControlIpc`: everything there drives ANOTHER computer, and everything here changes
 * what this one is willing to do. One credential-free snapshot and seven commands, over the stores
 * that already own each half - the config section, the credential store, the live listener.
 *
 * The snapshot is the only place the two directions meet: the profiles this computer dials and the
 * computers it has let in are written by different halves and neither implies the other, so a row
 * in one list says nothing about the other.
 *
 * The event is `remote:changed`, reused rather than doubled: it is parameter-less and the value
 * rides on the get, so a second event for the same change would be a second channel saying nothing
 * the first does not.
 */
export class ServiceRemoteSettingsIpc
  extends ServiceIpcBase<typeof ServiceRemoteSettingsIpc.channelsConst> {
  static readonly channelsConst = {
    'remoteSettings:get': true,
    'remoteSettings:listener-save': true,
    'remoteSettings:pairing-connect': true,
    'remoteSettings:profile-endpoint': true,
    'remoteSettings:profile-retry': true,
    'remoteSettings:profile-forget': true,
    'remoteSettings:inbound-revoke': true,
  } as const

  /**
   * `host:port`, or `[v6]:port`; a bare host is refused rather than given a port nobody typed. The
   * two host alternatives carry the character set `RemoteControlSettings` will store, so an address
   * that parses here is one the profile can be written with; only the bracketed one takes colons,
   * because outside brackets a colon is the separator.
   */
  private static readonly addressConst =
    /^(?:\[([A-Za-z0-9][A-Za-z0-9.:_-]{0,252})\]|([A-Za-z0-9][A-Za-z0-9._-]{0,252})):(\d{1,5})$/

  constructor(private readonly deps: ServiceRemoteSettingsIpcDeps) {
    super()
  }

  initialize(): void {
    this.register('remoteSettings:get', () => this.snapshot())
    this.register('remoteSettings:listener-save', (_event, listener) => this.saveListener(listener))
    this.register(
      'remoteSettings:pairing-connect',
      (_event, text) => this.pairingConnect(text),
    )
    this.register(
      'remoteSettings:profile-endpoint',
      (_event, profileId, endpoint) => this.completed(
        this.deps.lifecycle.setEndpoint(profileId, endpoint),
      ),
    )
    this.register('remoteSettings:profile-retry', (_event, profileId) => this.retry(profileId))
    this.register(
      'remoteSettings:profile-forget',
      (_event, profileId) => this.completed(this.deps.lifecycle.forget(profileId)),
    )
    this.register(
      'remoteSettings:inbound-revoke',
      (_event, remoteComputerId, remoteEndpointId) =>
        this.revokeInbound(remoteComputerId, remoteEndpointId),
    )
    this.assertComplete(ServiceRemoteSettingsIpc.channelsConst)
  }

  private snapshot(): RemoteSettingsSnapshotDto {
    const settings = this.deps.configStore.readSection(RemoteControlSettingsSection.spec)
    const outbound = new Map(this.deps.connections.snapshot().outbound
      .map((endpoint) => [endpoint.remoteEndpointId, endpoint]))
    return {
      identity: {
        remoteComputerId: this.deps.identity.remoteComputerId,
        remoteEndpointId: this.deps.identity.remoteEndpointId,
        displayName: this.deps.identity.displayName,
        fingerprint: this.deps.identity.signing.fingerprint,
        configIdentity: this.deps.identity.configIdentity,
        runtimeChannel: this.deps.identity.runtimeChannel,
      },
      bundleText: this.bundleText(),
      listener: {
        configured: { ...settings.listener },
        runtime: this.deps.listener.runtime(),
      },
      profiles: settings.profiles.map((profile) =>
        this.profileOf(profile, outbound.get(profile.remoteEndpointId))),
      inbound: this.inboundPeers(),
      sectionDamaged:
        this.deps.configStore.sectionDamage(RemoteControlSettingsSection.spec) !== null,
    }
  }

  /**
   * Turning the listener on, off or onto another port, in the one order that cannot leave the file
   * and the runtime disagreeing:
   *
   * 1. refuse what the file would refuse anyway, before a port is taken for a save that cannot land;
   * 2. bind, so a port already in use is reported instead of persisted;
   * 3. save over a FRESHLY read section, because a CLI pairing import may have written a profile
   *    while the bind was running and the section read before it no longer holds that profile;
   * 4. put the runtime back when the write is refused after all.
   */
  private async saveListener(
    next: RemoteControlListenerSettings,
  ): Promise<RemoteSettingsSaveResult> {
    const before = this.deps.configStore.readSection(RemoteControlSettingsSection.spec)
    const previous = { ...before.listener }
    const damaged = this.deps.configStore.sectionDamage(RemoteControlSettingsSection.spec)
    if (damaged !== null) return { ok: false, code: 'config-refused', detail: damaged.detail }
    const invalid = RemoteControlSettingsSection.spec
      .validate({ ...before, listener: { ...next } })
    if (invalid !== null) return { ok: false, code: 'config-refused', detail: invalid }
    const applied = await this.deps.listener.apply(next)
    if (!applied.ok) return ServiceRemoteSettingsIpc.applyRefusal(applied)
    const current = this.deps.configStore.readSection(RemoteControlSettingsSection.spec)
    const saved = this.deps.configStore.saveSection(
      RemoteControlSettingsSection.spec,
      { ...current, listener: { ...next } },
    )
    if (!saved.ok) {
      // The runtime is now bound to something the file does not hold. Putting it back can be refused
      // too - a quit that started meanwhile answers `stopping` - and then `failed` or `disabled` is
      // what a person is shown, which is the truth about the port either way.
      await this.deps.listener.apply(previous)
      return { ok: false, code: 'config-refused', detail: saved.detail }
    }
    this.deps.onChanged()
    return { ok: true }
  }

  /**
   * The one field on the screen, and the one decision about what was typed into it. A pasted bundle
   * is JSON and an address never is, so the `{` is the whole test; anything else has to read as
   * `host:port` or it is neither.
   *
   * The decision is here rather than in the renderer because it picks which of two trust statements
   * is being made - a key pinned before the first dial, or whatever the address serves - and the
   * screen draws what it is told rather than deciding what this computer will trust.
   */
  private async pairingConnect(text: string): Promise<RemoteSettingsSaveResult> {
    const trimmed = text.trim()
    let outcome: RemoteControlPairingImportResult
    if (trimmed.startsWith('{')) {
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) }
      catch (error) { return { ok: false, code: 'invalid-bundle', detail: ErrorText.of(error) } }
      outcome = await this.deps.pairing.import(parsed)
    } else {
      const endpoint = ServiceRemoteSettingsIpc.addressOf(trimmed)
      if (endpoint === null)
        return {
          ok: false,
          code: 'invalid-bundle',
          detail: 'Paste a pairing bundle or type host:port',
        }
      outcome = await this.deps.pairing.importFromAddress(endpoint)
    }
    if (!outcome.ok) return { ok: false, code: outcome.code, detail: outcome.detail }
    this.deps.connections.reloadProfiles()
    this.deps.onChanged()
    return { ok: true }
  }

  /**
   * Taking back what a person granted at the Allow dialog, in the one order that leaves nothing
   * behind: the handshake reads trust when a peer CONNECTS and never again, so a computer that was
   * let in yesterday keeps its control of this one until it next reconnects. The socket goes before
   * the file.
   *
   * Idempotent by both halves, so a row already gone answers `ok` rather than a refusal the screen
   * would have to word.
   */
  private revokeInbound(
    remoteComputerId: string,
    remoteEndpointId: string,
  ): RemoteSettingsSaveResult {
    this.deps.inbound.closeEndpoint(remoteComputerId, remoteEndpointId)
    this.deps.credentials.revokeInbound(remoteComputerId, remoteEndpointId)
    this.deps.onChanged()
    return { ok: true }
  }

  /**
   * The backoff dropped for ONE computer. The row names a profile and the connector is keyed by
   * endpoint, so the section is what resolves the two - freshly read, because the row a person is
   * looking at may already be a profile a CLI import replaced.
   *
   * It writes nothing and publishes nothing of its own: what a dial does reaches the screen through
   * the connector's own change, and the answer here is only whether there was anything to dial.
   */
  private retry(profileId: string): RemoteSettingsSaveResult {
    const profile = this.deps.configStore.readSection(RemoteControlSettingsSection.spec).profiles
      .find((candidate) => candidate.profileId === profileId)
    if (profile === undefined)
      return { ok: false, code: 'not-found', detail: `No paired computer ${profileId}` }
    this.deps.connections.retryNow(profile.remoteEndpointId)
    return { ok: true }
  }

  /**
   * The Allowed-in list, joined with the live connections for the dot. The identity is keyed by the
   * pair of ids and the registry by the endpoint, so the join is over the pair too: two computers
   * sharing an endpoint id would otherwise light each other's row.
   */
  private inboundPeers(): readonly RemoteSettingsInboundPeerDto[] {
    const live = new Set(this.deps.inbound.snapshot()
      .map((entry) =>
        `${entry.identity.remoteComputerId}\u0000${entry.identity.remoteEndpointId}`))
    return this.deps.credentials.inboundPeers().map((peer) => ({
      remoteComputerId: peer.identity.remoteComputerId,
      remoteEndpointId: peer.identity.remoteEndpointId,
      displayName: peer.identity.displayName,
      fingerprint: peer.identity.signing.fingerprint,
      addedAt: peer.addedAt,
      connected: live.has(
        `${peer.identity.remoteComputerId}\u0000${peer.identity.remoteEndpointId}`,
      ),
    }))
  }

  private profileOf(
    profile: RemoteControlPeerProfile,
    endpoint: RemoteOutboundEndpointDto | undefined,
  ): RemoteSettingsProfileDto {
    return {
      profileId: profile.profileId,
      displayName: profile.displayName,
      remoteComputerId: profile.remoteComputerId,
      remoteEndpointId: profile.remoteEndpointId,
      configIdentity: profile.configIdentity,
      runtimeChannel: profile.runtimeChannel,
      endpoint: { ...profile.endpoint },
      fingerprint: profile.pinnedIdentity.fingerprint,
      // The connector holds a state per profile only once it has read them, and one it has not seen
      // is exactly what idle means: paired, and nothing is asking for it.
      status: endpoint?.status ?? 'idle',
      error: endpoint?.error?.detail ?? null,
      lastConnectedAt: endpoint?.lastConnectedAt ?? null,
      nextRetryAt: endpoint?.nextRetryAt ?? null,
      applicationVersion: endpoint?.applicationVersion ?? null,
    }
  }

  /**
   * A typed address, or null for anything that is not one. The port is required: a default port
   * would be this computer guessing which machine a person meant, and the answer to that guess is a
   * fingerprint dialog for a stranger.
   */
  private static addressOf(text: string): RemoteControlPeerEndpoint | null {
    const match = ServiceRemoteSettingsIpc.addressConst.exec(text)
    if (match === null) return null
    const host = match[1] ?? match[2] ?? ''
    const port = Number(match[3])
    if (port < RemoteControlSettings.portMinConst || port > RemoteControlSettings.portMaxConst)
      return null
    return { host, port }
  }

  private bundleText(): string | null {
    // A bundle that was never published costs the Copy button, not the snapshot: the screen has the
    // fingerprint and the listener state either way, and both say more about what is wrong.
    try { return JSON.stringify(this.deps.pairing.bundle(), null, 2) }
    catch { return null }
  }

  /**
   * The lifecycle's words turned into the screen's. Enumerated rather than spread, so a third
   * refusal has to be given a word here before it can reach a person as one they have no sentence
   * for.
   */
  private completed(result: RemoteProfileSaveResult): RemoteSettingsSaveResult {
    if (result.ok) {
      this.deps.onChanged()
      return { ok: true }
    } else if (result.code === 'not-found')
      return { ok: false, code: 'not-found', detail: result.detail }
    else if (result.code === 'config-refused')
      return { ok: false, code: 'config-refused', detail: result.detail }
    else
      throw new Error(`Unknown remote profile result: ${JSON.stringify(result)}`)
  }

  /**
   * Enumerated rather than spread, and that is the point: the codes are the listener's vocabulary
   * and these are the screen's, so a fourth refusal has to be given a word here before it can reach
   * a person as one they have no sentence for.
   */
  private static applyRefusal(
    applied: Extract<RemoteListenerApplyResult, { ok: false }>,
  ): RemoteSettingsSaveResult {
    if (applied.code === 'busy')
      return { ok: false, code: 'busy', detail: applied.detail }
    else if (applied.code === 'stopping')
      return { ok: false, code: 'stopping', detail: applied.detail }
    else if (applied.code === 'bind-failed')
      return { ok: false, code: 'bind-failed', detail: applied.detail }
    else
      throw new Error(`Unknown remote listener refusal: ${JSON.stringify(applied)}`)
  }
}
