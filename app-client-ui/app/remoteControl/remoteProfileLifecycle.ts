import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import {
  RemoteControlSettings,
  type RemoteControlSettingsValue,
} from '../../shared/remoteControlSettings'
import type { RemoteConnectionsManager } from './remoteConnectionsManager'
import { RemoteControlSettingsSection } from './remoteControlSettingsSection'

export type RemoteProfileSaveResult =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'config-refused'; detail: string }

export interface RemoteProfileLifecycleDeps {
  configStore: ConfigStore
  connections: Pick<RemoteConnectionsManager, 'reloadProfiles'>
}

/**
 * Changing what this computer does about one computer it is paired with: whether it dials it, where
 * it dials it, and whether it keeps the profile at all.
 *
 * **Outbound only, over one store.** What that computer may do HERE is not this class's and not
 * this profile's: it lives in `RemotePeerCredentialStore`'s trust file, is written by a person
 * answering `RemoteInboundApprovalManager`'s dialog, and is taken back by Revoke in the Allowed-in
 * list. Nothing here asks a person anything, because nothing here grants anybody anything.
 */
export class RemoteProfileLifecycle {
  constructor(private readonly deps: RemoteProfileLifecycleDeps) {}

  setEndpoint(profileId: string, endpoint: RemoteControlPeerEndpoint): RemoteProfileSaveResult {
    // Where a computer answers, not who it is: the pinned identity decides the handshake either way,
    // so moving the address grants nothing and asks nobody.
    return this.write(profileId, (previous) =>
      ({ ...previous, endpoint: { host: endpoint.host, port: endpoint.port } }))
  }

  /**
   * Removes the profile, and only that. The trust that lets that computer in here was never this
   * profile's to hold, so forgetting it here leaves whatever was allowed in still allowed in - the
   * Allowed-in list is where that is taken back, and it is the other computer's person who does it.
   */
  forget(profileId: string): RemoteProfileSaveResult {
    const settings = this.settings()
    if (RemoteProfileLifecycle.profileOf(settings, profileId) === undefined)
      return RemoteProfileLifecycle.notFound(profileId)
    return this.save(RemoteControlSettings.withoutProfile(settings, profileId))
  }

  private write(
    profileId: string,
    change: (previous: RemoteControlPeerProfile) => RemoteControlPeerProfile,
  ): RemoteProfileSaveResult {
    const settings = this.settings()
    const previous = RemoteProfileLifecycle.profileOf(settings, profileId)
    if (previous === undefined) return RemoteProfileLifecycle.notFound(profileId)
    return this.save(RemoteControlSettings.withProfile(settings, change(previous)))
  }

  private save(next: RemoteControlSettingsValue): RemoteProfileSaveResult {
    const saved = this.deps.configStore.saveSection(RemoteControlSettingsSection.spec, next)
    if (!saved.ok) return { ok: false, code: 'config-refused', detail: saved.detail }
    // The outbound connector reads the profiles it was given, so it has to be told to read again.
    this.deps.connections.reloadProfiles()
    return { ok: true }
  }

  private settings(): RemoteControlSettingsValue {
    return this.deps.configStore.readSection(RemoteControlSettingsSection.spec)
  }

  private static profileOf(
    settings: RemoteControlSettingsValue,
    profileId: string,
  ): RemoteControlPeerProfile | undefined {
    return settings.profiles.find((candidate) => candidate.profileId === profileId)
  }

  private static notFound(profileId: string): RemoteProfileSaveResult {
    return { ok: false, code: 'not-found', detail: `No paired computer with profile ${profileId}` }
  }
}
