import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { RemoteControlPairing } from '../../../lib-orchestrator/remoteControl/remoteControlPairing'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import type {
  RemoteControlPeerIdentity,
  RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlSettings } from '../../shared/remoteControlSettings'
import { RemoteControlSettingsSection } from './remoteControlSettingsSection'
import { RemoteEndpointIdentityStore } from './remoteEndpointIdentityStore'
import { RemoteProfileLifecycle } from './remoteProfileLifecycle'
import { RemotePeerCredentialStore } from './remotePeerCredentialStore'

describe('app-client-ui/app/remoteControl/remoteProfileLifecycle', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * Inverted from the pairing model this replaced, on purpose. The two directions are independent
   * now: what that computer may do HERE was never granted by this profile, so removing the profile
   * cannot take it back. Revoke in the Allowed-in list is the only inbound removal.
   */
  it('forgets a computer by removing the profile and nothing else', () => {
    const harness = RemoteProfileLifecycleTest.harness(roots)
    const profile = harness.pair()
    harness.allowIn()

    expect(harness.lifecycle.forget(profile.profileId)).toEqual({ ok: true })

    expect(harness.storedProfile(profile.profileId)).toBeUndefined()
    expect(harness.trustedInbound(profile)).not.toBeNull()
    expect(harness.reloads).toBe(1)
  })

  it('answers not-found for a profile ID nothing holds', () => {
    const harness = RemoteProfileLifecycleTest.harness(roots)

    expect(harness.lifecycle.forget('missing')).toMatchObject({ ok: false, code: 'not-found' })
    expect(harness.lifecycle.setEndpoint('missing', { host: 'other.lan', port: 47_152 }))
      .toMatchObject({ ok: false, code: 'not-found' })
    expect(harness.reloads).toBe(0)
  })

  it('moves an endpoint without touching the trust that lets that computer in', () => {
    const harness = RemoteProfileLifecycleTest.harness(roots)
    const profile = harness.pair()
    harness.allowIn()

    expect(harness.lifecycle.setEndpoint(profile.profileId, { host: 'moved.lan', port: 47_152 }))
      .toEqual({ ok: true })

    expect(harness.storedProfile(profile.profileId)?.endpoint)
      .toEqual({ host: 'moved.lan', port: 47_152 })
    expect(harness.trustedInbound(profile)).not.toBeNull()
  })

  /**
   * The migration end to end: a config.json written before the two directions were told apart is
   * read, and the first write over it stores the new spelling and only that one. The legacy shape
   * must therefore not be damaged, or the store would refuse this very save.
   */
  it('reads a legacy profile and drops its outbound right on the next save', () => {
    const harness = RemoteProfileLifecycleTest.harness(roots)
    const profile = harness.pairLegacy()

    expect(harness.lifecycle.setEndpoint(profile.profileId, { host: '10.0.0.9', port: 47_151 }))
      .toEqual({ ok: true })

    const written = harness.rawProfile(profile.profileId)
    expect(written).toMatchObject({ endpoint: { host: '10.0.0.9', port: 47_151 } })
    expect(written).not.toHaveProperty('enabled')
    expect(written).not.toHaveProperty('outboundEnabled')
  })
})

class RemoteProfileLifecycleTest {
  readonly lifecycle: RemoteProfileLifecycle
  reloads = 0

  private constructor(
    private readonly root: string,
    private readonly config: ConfigStore,
    private readonly credentials: RemotePeerCredentialStore,
    private readonly remoteIdentity: RemoteControlPeerIdentity,
  ) {
    this.lifecycle = new RemoteProfileLifecycle({
      configStore: config,
      connections: { reloadProfiles: () => { this.reloads += 1 } },
    })
  }

  static harness(roots: string[]): RemoteProfileLifecycleTest {
    const root = RemoteProfileLifecycleTest.root(roots, 'local')
    const remoteRoot = RemoteProfileLifecycleTest.root(roots, 'remote')
    return new RemoteProfileLifecycleTest(
      root,
      ConfigStore.load(root, {
        snapshotsDirectory: join(root, 'snapshots'),
        report: () => undefined,
      }),
      RemoteProfileLifecycleTest.credentials(root, 'local'),
      RemoteProfileLifecycleTest.identity(remoteRoot, 'remote'),
    )
  }

  /** Puts one paired computer in the config section, the way an accepted import leaves it. */
  pair(): RemoteControlPeerProfile {
    const profile = this.profile()
    const saved = this.config.saveSection(
      RemoteControlSettingsSection.spec,
      RemoteControlSettings.withProfile(
        this.config.readSection(RemoteControlSettingsSection.spec),
        profile,
      ),
    )
    if (!saved.ok) throw new Error(`The test could not store its profile: ${saved.detail}`)
    return profile
  }

  /** The other half, written the only way it is written now: by somebody answering the dialog. */
  allowIn(): void {
    this.credentials.trustInbound(this.remoteIdentity)
  }

  /**
   * The same pairing as it sits in a config.json written while an outbound right was still stored.
   * Written as the store's FIRST sight of the file on purpose: a save followed by a hand write can
   * land in the same millisecond, and the store re-reads on the file mtime.
   */
  pairLegacy(): RemoteControlPeerProfile {
    const profile = this.profile()
    writeFileSync(join(this.root, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      remoteControl: {
        listener: RemoteControlSettings.defaultValue().listener,
        profiles: [{ ...profile, enabled: false }],
      },
    }), 'utf8')
    return profile
  }

  storedProfile(profileId: string): RemoteControlPeerProfile | undefined {
    return this.config.readSection(RemoteControlSettingsSection.spec).profiles
      .find((candidate) => candidate.profileId === profileId)
  }

  /** The raw JSON, because the coerced view drops a legacy key whatever the file still holds. */
  rawProfile(profileId: string): Record<string, unknown> | undefined {
    const document = JSON.parse(readFileSync(join(this.root, 'config.json'), 'utf8')) as {
      remoteControl: { profiles: Record<string, unknown>[] }
    }
    return document.remoteControl.profiles.find((candidate) => candidate.profileId === profileId)
  }

  trustedInbound(profile: RemoteControlPeerProfile): RemoteControlPeerIdentity | null {
    return this.credentials.trustedInbound(profile.remoteComputerId, profile.remoteEndpointId)
  }

  private profile(): RemoteControlPeerProfile {
    return RemoteControlPairing.profile(
      RemoteControlPairing.bundle(this.remoteIdentity, { host: 'remote.lan', port: 47_151 }),
      { profileId: 'profile-remote' },
    )
  }

  private static root(roots: string[], name: string): string {
    const root = mkdtempSync(join(tmpdir(), `jamat-v3-profile-${name}-`))
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
    const credentials = RemoteProfileLifecycleTest.credentials(root, name)
    return RemoteEndpointIdentityStore.loadOrCreate(
      join(root, 'endpoint.json'),
      credentials.machineIdentity(),
      `config-${name}`,
      'development',
      () => `endpoint-${name}`,
    ).identity(credentials.machineIdentity())
  }
}
