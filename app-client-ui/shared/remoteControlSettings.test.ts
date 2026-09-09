import { describe, expect, it } from 'vitest'

import type { RemoteControlPeerProfile } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlSettings } from './remoteControlSettings'

describe('app-client-ui/shared/remoteControlSettings', () => {
  it('defaults to a disabled listener and no peers', () => {
    expect(RemoteControlSettings.defaultValue()).toEqual({
      listener: {
        enabled: false,
        bindHost: '0.0.0.0',
        port: 47_150,
        advertisedHost: '127.0.0.1',
      },
      profiles: [],
    })
  })

  it('accepts two computers with the same display name when their identities differ', () => {
    const first = RemoteControlSettings.withProfile(
      RemoteControlSettings.defaultValue(),
      RemoteControlSettingsTest.profile('profile-a', 'computer-a', 'endpoint-a'),
    )
    const both = RemoteControlSettings.withProfile(
      first,
      RemoteControlSettingsTest.profile('profile-b', 'computer-b', 'endpoint-b'),
    )
    expect(RemoteControlSettings.isValid(both)).toBe(true)
    expect(both.profiles.map((profile) => profile.displayName)).toEqual(['Same name', 'Same name'])
  })

  it('replaces a profile by stable ID and rejects duplicate endpoint identities', () => {
    const first = RemoteControlSettings.withProfile(
      RemoteControlSettings.defaultValue(),
      RemoteControlSettingsTest.profile('profile-a', 'computer-a', 'endpoint-a'),
    )
    const replaced = RemoteControlSettings.withProfile(first, {
      ...RemoteControlSettingsTest.profile('profile-a', 'computer-a', 'endpoint-a'),
      displayName: 'Renamed',
    })
    expect(replaced.profiles).toHaveLength(1)
    expect(replaced.profiles[0]?.displayName).toBe('Renamed')
    expect(RemoteControlSettings.isValid({
      ...replaced,
      profiles: [
        RemoteControlSettingsTest.profile('profile-a', 'computer-a', 'endpoint-a'),
        RemoteControlSettingsTest.profile('profile-b', 'computer-b', 'endpoint-a'),
      ],
    })).toBe(false)
  })

  it('reports a damaged hand edit and keeps it from becoming an enabled fallback', () => {
    const messages: string[] = []
    const raw = { listener: { enabled: true, bindHost: '*', port: 'open' }, profiles: [] }
    expect(RemoteControlSettings.coerce(raw, (message) => messages.push(message)))
      .toEqual(RemoteControlSettings.defaultValue())
    expect(RemoteControlSettings.isDamaged(raw)).toBe(true)
    expect(RemoteControlSettings.isDamaged(undefined)).toBe(false)
    expect(messages).toHaveLength(1)
  })

  /*
   * Both spellings this profile once carried an outbound right in are read by nobody now: a
   * connection stands while something needs it. A file still holding one must NOT be damaged -
   * damaged refuses the section its own save, and that save is the one that drops the key.
   */
  it('ignores a legacy outbound right in either spelling and leaves the section saveable', () => {
    for (const legacy of [{ outboundEnabled: false }, { enabled: false }]) {
      const messages: string[] = []
      const raw = {
        listener: RemoteControlSettings.defaultValue().listener,
        profiles: [{
          ...RemoteControlSettingsTest.profile('profile-a', 'computer-a', 'endpoint-a'),
          ...legacy,
        }],
      }

      const coerced = RemoteControlSettings.coerce(raw, (message) => messages.push(message))

      expect(messages).toEqual([])
      expect(RemoteControlSettings.isDamaged(raw)).toBe(false)
      expect(coerced.profiles[0]).toMatchObject({ profileId: 'profile-a' })
      expect(coerced.profiles[0]).not.toHaveProperty('enabled')
      expect(coerced.profiles[0]).not.toHaveProperty('outboundEnabled')
      // Which is what the next save writes back: the profile without either key.
      expect(RemoteControlSettings.isValid(coerced)).toBe(true)
    }
  })

  it('removes exactly one profile by ID', () => {
    const both = RemoteControlSettings.withProfile(
      RemoteControlSettings.withProfile(
        RemoteControlSettings.defaultValue(),
        RemoteControlSettingsTest.profile('profile-a', 'computer-a', 'endpoint-a'),
      ),
      RemoteControlSettingsTest.profile('profile-b', 'computer-b', 'endpoint-b'),
    )

    const left = RemoteControlSettings.withoutProfile(both, 'profile-a')

    expect(left.profiles.map((profile) => profile.profileId)).toEqual(['profile-b'])
    expect(RemoteControlSettings.withoutProfile(left, 'profile-a')).toEqual(left)
  })
})

class RemoteControlSettingsTest {
  static profile(
    profileId: string,
    remoteComputerId: string,
    remoteEndpointId: string,
  ): RemoteControlPeerProfile {
    return {
      profileId,
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${profileId}`,
      runtimeChannel: 'development',
      displayName: 'Same name',
      endpoint: { host: '127.0.0.1', port: 47_151 },
      pinnedIdentity: {
        algorithm: 'ed25519',
        publicKey: 'a'.repeat(64),
        fingerprint: 'b'.repeat(43),
      },
    }
  }
}
