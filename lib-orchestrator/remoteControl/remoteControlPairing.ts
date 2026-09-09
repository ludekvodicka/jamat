import { randomUUID } from 'node:crypto'

import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerIdentity,
  RemoteControlPeerPairingBundle,
  RemoteControlPeerProfile,
} from './remoteControlPeerApi.types'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import { RemoteControlPeerHandshakeError } from './core/remoteControlPeerHandshakeError'
import { RemoteControlPeerIdentityValidation } from './remoteControlPeerIdentityValidation'
import { JsonShape } from '../shared/jsonShape'

export class RemoteControlPairing {
  static bundle(
    identity: RemoteControlPeerIdentity,
    endpoint: RemoteControlPeerEndpoint,
  ): RemoteControlPeerPairingBundle {
    RemoteControlPeerIdentityValidation.assertPeer(identity)
    RemoteControlPairing.assertEndpoint(endpoint)
    return {
      schemaVersion: 1,
      protocol: RemoteControlPeerConst.protocol,
      identity: structuredClone(identity),
      endpoint: structuredClone(endpoint),
    }
  }

  static parse(input: unknown): RemoteControlPeerPairingBundle {
    if (!JsonShape.isRecord(input)
      || !RemoteControlPairing.exactKeys(input, ['schemaVersion', 'protocol', 'identity', 'endpoint'])
      || input.schemaVersion !== 1
      || input.protocol !== RemoteControlPeerConst.protocol)
      throw new Error('Remote pairing bundle is invalid')
    RemoteControlPeerIdentityValidation.assertPeer(input.identity)
    RemoteControlPairing.assertEndpoint(input.endpoint)
    return {
      schemaVersion: 1,
      protocol: RemoteControlPeerConst.protocol,
      identity: structuredClone(input.identity),
      endpoint: structuredClone(input.endpoint),
    }
  }

  static profile(
    bundleInput: unknown,
    options?: { profileId?: string },
  ): RemoteControlPeerProfile {
    const bundle = RemoteControlPairing.parse(bundleInput)
    const profile: RemoteControlPeerProfile = {
      profileId: options?.profileId ?? randomUUID(),
      remoteComputerId: bundle.identity.remoteComputerId,
      remoteEndpointId: bundle.identity.remoteEndpointId,
      configIdentity: bundle.identity.configIdentity,
      runtimeChannel: bundle.identity.runtimeChannel,
      displayName: bundle.identity.displayName,
      endpoint: structuredClone(bundle.endpoint),
      pinnedIdentity: structuredClone(bundle.identity.signing),
    }
    RemoteControlPairing.assertProfile(profile)
    return profile
  }

  /**
   * `outboundEnabled` and its older spelling `enabled` are TOLERATED and read by nobody. A profile
   * written before 2026-09-07 still holds one of them, and a file that refuses to parse is a whole
   * remoteControl section reported damaged - which would take the pairing with it. They are dropped
   * from the file by the next write of the section, because the writer serialises the parsed shape.
   */
  static assertProfile(profile: RemoteControlPeerProfile): void {
    if (!JsonShape.isRecord(profile)
      || !RemoteControlPairing.keys(
        profile,
        [
          'profileId',
          'remoteComputerId',
          'remoteEndpointId',
          'configIdentity',
          'runtimeChannel',
          'displayName',
          'endpoint',
          'pinnedIdentity',
        ],
        ['outboundEnabled', 'enabled'],
      )
      || !RemoteControlPairing.id(profile.profileId))
      throw new RemoteControlPeerHandshakeError('invalid-handshake', 'Peer profile is invalid')
    RemoteControlPairing.assertEndpoint(profile.endpoint)
    RemoteControlPeerIdentityValidation.assertPeer({
      remoteComputerId: profile.remoteComputerId,
      remoteEndpointId: profile.remoteEndpointId,
      configIdentity: profile.configIdentity,
      runtimeChannel: profile.runtimeChannel,
      displayName: profile.displayName,
      signing: profile.pinnedIdentity,
    })
  }

  private static assertEndpoint(input: unknown): asserts input is RemoteControlPeerEndpoint {
    if (!JsonShape.isRecord(input)
      || !RemoteControlPairing.exactKeys(input, ['host', 'port'])
      || !RemoteControlPairing.host(input.host)
      || !RemoteControlPairing.port(input.port))
      throw new Error('Remote peer endpoint is invalid')
  }

  private static exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return RemoteControlPairing.keys(value, expected, [])
  }

  /** Every required key present, and nothing beyond them except the ones named as tolerated. */
  private static keys(
    value: Record<string, unknown>,
    required: readonly string[],
    tolerated: readonly string[],
  ): boolean {
    const actual = Object.keys(value)
    return required.every((key) => actual.includes(key))
      && actual.every((key) => required.includes(key) || tolerated.includes(key))
  }


  private static id(value: unknown): value is string {
    return typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  }


  private static host(value: unknown): value is string {
    return typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9.:[\]_-]{0,252}$/.test(value)
  }

  private static port(value: unknown): value is number {
    return typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= 1
      && value <= 65_535
  }

}
