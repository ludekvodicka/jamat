import { JsonShape } from '../shared/jsonShape'
import type {
  RemoteControlMachineIdentity,
  RemoteControlPeerIdentity,
} from './remoteControlPeerApi.types'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import { RemoteControlPeerKeys } from './remoteControlPeerKeys'

/**
 * What counts as an identity, in one place.
 *
 * Five gates used to decide this with three different rule sets: the pairing parser checked exact
 * keys, an identifier pattern and that the fingerprint really belongs to the public key; the two
 * credential files on disk checked lengths and skipped the pattern; the settings section had a key
 * length of its own. An identity one gate accepts and another refuses is not a small inconsistency
 * on a surface whose whole job is deciding which machine is which - so the strictest of the three
 * became the only one.
 *
 * The fingerprint is derived, never trusted: it is checked against the key it claims to summarise,
 * which is what makes it usable as the thing two people compare out of band.
 */
export class RemoteControlPeerIdentityValidation {
  private static readonly identifierConst = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/
  private static readonly encodedConst = /^[A-Za-z0-9_-]{32,4096}$/
  private static readonly displayNameLengthConst = 256

  static isMachine(value: unknown): value is RemoteControlMachineIdentity {
    return JsonShape.isRecord(value)
      && RemoteControlPeerIdentityValidation.exactKeys(value, [
        'remoteComputerId',
        'displayName',
        'signing',
      ])
      && RemoteControlPeerIdentityValidation.machineFields(value)
  }

  static isPeer(value: unknown): value is RemoteControlPeerIdentity {
    return JsonShape.isRecord(value)
      && RemoteControlPeerIdentityValidation.exactKeys(value, [
        'remoteComputerId',
        'remoteEndpointId',
        'configIdentity',
        'runtimeChannel',
        'displayName',
        'signing',
      ])
      && RemoteControlPeerIdentityValidation.machineFields(value)
      && RemoteControlPeerIdentityValidation.identifier(value.remoteEndpointId)
      && RemoteControlPeerIdentityValidation.identifier(value.configIdentity)
      && (value.runtimeChannel === 'development' || value.runtimeChannel === 'production')
  }

  static assertPeer(value: unknown): asserts value is RemoteControlPeerIdentity {
    if (!RemoteControlPeerIdentityValidation.isPeer(value))
      throw new Error('Remote peer identity is invalid')
  }

  private static machineFields(value: Record<string, unknown>): boolean {
    const signing = JsonShape.record(value.signing)
    return RemoteControlPeerIdentityValidation.identifier(value.remoteComputerId)
      && RemoteControlPeerIdentityValidation.displayName(value.displayName)
      && signing !== null
      && RemoteControlPeerIdentityValidation.exactKeys(signing, [
        'algorithm',
        'publicKey',
        'fingerprint',
      ])
      && signing.algorithm === RemoteControlPeerConst.signingAlgorithm
      && RemoteControlPeerIdentityValidation.encoded(signing.publicKey)
      && RemoteControlPeerIdentityValidation.encoded(signing.fingerprint)
      && RemoteControlPeerKeys.validatePublicKey(signing.publicKey as string)
      && RemoteControlPeerKeys.fingerprint(signing.publicKey as string) === signing.fingerprint
  }

  /** No field nobody declared: an unread extra is how a second meaning travels beside the first. */
  private static exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const found = Object.keys(value)
    return found.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  }

  private static identifier(value: unknown): boolean {
    return typeof value === 'string'
      && RemoteControlPeerIdentityValidation.identifierConst.test(value)
  }

  private static encoded(value: unknown): boolean {
    return typeof value === 'string' && RemoteControlPeerIdentityValidation.encodedConst.test(value)
  }

  private static displayName(value: unknown): boolean {
    return typeof value === 'string'
      && value.trim().length > 0
      && value.length <= RemoteControlPeerIdentityValidation.displayNameLengthConst
      && !/[\r\n]/.test(value)
  }
}
