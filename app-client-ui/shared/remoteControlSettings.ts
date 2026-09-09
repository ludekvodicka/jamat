import type { RemoteControlPeerProfile } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'

export interface RemoteControlListenerSettings {
  enabled: boolean
  bindHost: string
  port: number
  advertisedHost: string
}

export interface RemoteControlSettingsValue {
  listener: RemoteControlListenerSettings
  profiles: RemoteControlPeerProfile[]
}

export class RemoteControlSettings {
  /**
   * The range a port field may offer, public because the Remote Control screen draws it: the form
   * bounds the number it sends and this validator refuses everything else, and two spellings of one
   * range is how a field starts offering a value its own writer rejects.
   */
  static readonly portMinConst = 1
  static readonly portMaxConst = 65_535
  private static readonly identifierConst = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/
  private static readonly hostConst = /^[A-Za-z0-9][A-Za-z0-9.:[\]_-]{0,252}$/
  private static readonly encodedKeyConst = /^[A-Za-z0-9_-]{32,2048}$/

  static defaultValue(): RemoteControlSettingsValue {
    return {
      listener: {
        enabled: false,
        bindHost: '0.0.0.0',
        port: 47_150,
        advertisedHost: '127.0.0.1',
      },
      profiles: [],
    }
  }

  static coerce(value: unknown, report: (message: string) => void): RemoteControlSettingsValue {
    if (value === undefined) return RemoteControlSettings.defaultValue()
    if (!RemoteControlSettings.record(value)) {
      report('The remoteControl section of config.json is not an object; remote control is disabled')
      return RemoteControlSettings.defaultValue()
    }
    const listener = RemoteControlSettings.listener(value.listener)
    const profiles = RemoteControlSettings.profiles(value.profiles)
    if (listener === null || profiles === null) {
      report('The remoteControl section of config.json is damaged; remote control is disabled')
      return RemoteControlSettings.defaultValue()
    }
    return { listener, profiles }
  }

  static isValid(value: unknown): value is RemoteControlSettingsValue {
    if (!RemoteControlSettings.record(value)) return false
    return RemoteControlSettings.listener(value.listener) !== null
      && RemoteControlSettings.profiles(value.profiles) !== null
  }

  static isDamaged(value: unknown): boolean {
    return value !== undefined && !RemoteControlSettings.isValid(value)
  }

  static withProfile(
    value: RemoteControlSettingsValue,
    profile: RemoteControlPeerProfile,
  ): RemoteControlSettingsValue {
    const profiles = value.profiles.filter((candidate) => candidate.profileId !== profile.profileId)
    return { ...value, profiles: [...profiles, structuredClone(profile)] }
  }

  static withoutProfile(
    value: RemoteControlSettingsValue,
    profileId: string,
  ): RemoteControlSettingsValue {
    return {
      ...value,
      profiles: value.profiles.filter((candidate) => candidate.profileId !== profileId),
    }
  }

  private static listener(value: unknown): RemoteControlListenerSettings | null {
    if (!RemoteControlSettings.record(value)
      || typeof value.enabled !== 'boolean'
      || !RemoteControlSettings.host(value.bindHost)
      || !RemoteControlSettings.port(value.port)
      || !RemoteControlSettings.host(value.advertisedHost))
      return null
    return {
      enabled: value.enabled,
      bindHost: value.bindHost,
      port: value.port,
      advertisedHost: value.advertisedHost,
    }
  }

  private static profiles(value: unknown): RemoteControlPeerProfile[] | null {
    if (!Array.isArray(value)) return null
    const profiles: RemoteControlPeerProfile[] = []
    const profileIds = new Set<string>()
    const endpointIds = new Set<string>()
    for (const candidate of value) {
      const profile = RemoteControlSettings.profile(candidate)
      if (profile === null
        || profileIds.has(profile.profileId)
        || endpointIds.has(profile.remoteEndpointId))
        return null
      profileIds.add(profile.profileId)
      endpointIds.add(profile.remoteEndpointId)
      profiles.push(profile)
    }
    return profiles
  }

  private static profile(value: unknown): RemoteControlPeerProfile | null {
    if (!RemoteControlSettings.record(value)) return null
    if (!RemoteControlSettings.id(value.profileId)
      || !RemoteControlSettings.id(value.remoteComputerId)
      || !RemoteControlSettings.id(value.remoteEndpointId)
      || !RemoteControlSettings.id(value.configIdentity)
      || (value.runtimeChannel !== 'development' && value.runtimeChannel !== 'production')
      || !RemoteControlSettings.displayName(value.displayName)
      || !RemoteControlSettings.record(value.endpoint)
      || !RemoteControlSettings.host(value.endpoint.host)
      || !RemoteControlSettings.port(value.endpoint.port)
      || !RemoteControlSettings.record(value.pinnedIdentity)
      || value.pinnedIdentity.algorithm !== 'ed25519'
      || !RemoteControlSettings.key(value.pinnedIdentity.publicKey)
      || !RemoteControlSettings.key(value.pinnedIdentity.fingerprint))
      return null
    return {
      profileId: value.profileId,
      remoteComputerId: value.remoteComputerId,
      remoteEndpointId: value.remoteEndpointId,
      configIdentity: value.configIdentity,
      runtimeChannel: value.runtimeChannel,
      displayName: value.displayName,
      endpoint: { host: value.endpoint.host, port: value.endpoint.port },
      pinnedIdentity: {
        algorithm: 'ed25519',
        publicKey: value.pinnedIdentity.publicKey,
        fingerprint: value.pinnedIdentity.fingerprint,
      },
    }
  }

  private static record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private static id(value: unknown): value is string {
    return typeof value === 'string' && RemoteControlSettings.identifierConst.test(value)
  }

  private static host(value: unknown): value is string {
    return typeof value === 'string' && RemoteControlSettings.hostConst.test(value)
  }

  private static port(value: unknown): value is number {
    return typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= RemoteControlSettings.portMinConst
      && value <= RemoteControlSettings.portMaxConst
  }

  private static displayName(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
  }

  private static key(value: unknown): value is string {
    return typeof value === 'string' && RemoteControlSettings.encodedKeyConst.test(value)
  }
}
