import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

import type {
  RemoteControlMachineIdentity,
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import {
  RemoteControlPeerKeys,
  type RemoteControlPeerSigningKeyPair,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteControlPeerIdentityValidation } from '../../../lib-orchestrator/remoteControl/remoteControlPeerIdentityValidation'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { RemoteMachineIdentityStore } from './remoteMachineIdentityStore'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

export interface RemotePeerTrustedIdentity {
  identity: RemoteControlPeerIdentity
  addedAt: number
}

interface RemotePeerCredentialDocument {
  schemaVersion: 1
  identity: RemoteControlMachineIdentity
  privateKey: string
  inboundPeers: RemotePeerTrustedIdentity[]
}

export interface RemotePeerCredentialStoreDeps {
  computerId(): string
  displayName(): string
  keyPair(): RemoteControlPeerSigningKeyPair
}

export class RemotePeerCredentialStore {
  private readonly privateKey: string
  private document: RemotePeerCredentialDocument

  private constructor(
    private readonly file: string,
    document: RemotePeerCredentialDocument,
  ) {
    this.document = document
    this.privateKey = document.privateKey
  }

  static loadOrCreate(
    file: string,
    publicIdentityFile: string,
    deps?: Partial<RemotePeerCredentialStoreDeps>,
  ): RemotePeerCredentialStore {
    const identityStore = new RemoteMachineIdentityStore(publicIdentityFile)
    const publicIdentity = identityStore.read()
    let document: RemotePeerCredentialDocument
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!RemotePeerCredentialStore.validDocument(parsed))
        throw new Error(`Remote peer credentials at ${file} are invalid`)
      document = parsed
      if (RemoteControlPeerKeys.publicFromPrivate(document.privateKey)
        !== document.identity.signing.publicKey)
        throw new Error(`Remote peer credentials at ${file} do not match their public identity`)
      if (publicIdentity !== null
        && !RemotePeerCredentialStore.sameMachineIdentity(publicIdentity, document.identity))
        throw new Error('Remote machine identity and peer credentials disagree')
      if (publicIdentity === null) identityStore.write(document.identity)
    } else {
      if (publicIdentity !== null)
        throw new Error('Remote machine private key is missing; refusing to replace its identity')
      const keyPair = (deps?.keyPair ?? RemoteControlPeerKeys.generateSigningKeyPair)()
      const identity: RemoteControlMachineIdentity = {
        remoteComputerId: (deps?.computerId ?? randomUUID)(),
        displayName: (deps?.displayName ?? hostname)(),
        signing: {
          algorithm: 'ed25519',
          publicKey: keyPair.publicKey,
          fingerprint: RemoteControlPeerKeys.fingerprint(keyPair.publicKey),
        },
      }
      document = { schemaVersion: 1, identity, privateKey: keyPair.privateKey, inboundPeers: [] }
      if (!RemotePeerCredentialStore.validDocument(document))
        throw new Error('Generated remote peer credentials are invalid')
      AtomicJsonFile.ensureDirectory(dirname(file))
      AtomicJsonFile.write(file, document)
      identityStore.write(identity)
    }
    return new RemotePeerCredentialStore(file, document)
  }

  machineIdentity(): RemoteControlMachineIdentity {
    return structuredClone(this.document.identity)
  }

  sign(payload: Buffer): string {
    return RemoteControlPeerKeys.sign(this.privateKey, payload)
  }

  /**
   * The FILE is the record and memory follows it, never the other way round: a write that throws
   * used to leave this process answering "trusted" for a peer the next start would not know.
   */
  trustInbound(identity: RemoteControlPeerIdentity, now = Date.now()): void {
    this.assertInboundIdentity(identity)
    const peers = [...this.document.inboundPeers]
    const index = peers.findIndex((candidate) =>
      candidate.identity.remoteComputerId === identity.remoteComputerId
      && candidate.identity.remoteEndpointId === identity.remoteEndpointId)
    if (index >= 0) {
      const existing = peers[index]
      if (!existing) throw new Error('Inbound peer index disappeared')
      if (existing.identity.signing.publicKey !== identity.signing.publicKey
        || existing.identity.signing.fingerprint !== identity.signing.fingerprint)
        throw new Error('Inbound remote peer is already pinned to another identity')
      peers[index] = { identity: structuredClone(identity), addedAt: existing.addedAt }
    } else
      peers.push({ identity: structuredClone(identity), addedAt: now })
    this.commit({ ...this.document, inboundPeers: peers })
  }

  assertInboundIdentity(identity: RemoteControlPeerIdentity): void {
    if (!RemoteControlPeerIdentityValidation.isPeer(identity))
      throw new Error('Inbound remote peer identity is invalid')
    const existing = this.trustedInbound(identity.remoteComputerId, identity.remoteEndpointId)
    if (existing !== null
      && (existing.signing.publicKey !== identity.signing.publicKey
        || existing.signing.fingerprint !== identity.signing.fingerprint))
      throw new Error('Inbound remote peer is already pinned to another identity')
  }

  revokeInbound(remoteComputerId: string, remoteEndpointId: string): void {
    const next = this.document.inboundPeers.filter((candidate) =>
      candidate.identity.remoteComputerId !== remoteComputerId
      || candidate.identity.remoteEndpointId !== remoteEndpointId)
    if (next.length === this.document.inboundPeers.length) return
    this.commit({ ...this.document, inboundPeers: next })
  }

  /** Every computer allowed in, for the settings screen: identities and `addedAt`, nothing secret. */
  inboundPeers(): readonly RemotePeerTrustedIdentity[] {
    return structuredClone(this.document.inboundPeers)
  }

  trustedInbound(
    remoteComputerId: string,
    remoteEndpointId: string,
  ): RemoteControlPeerIdentity | null {
    const found = this.document.inboundPeers.find((candidate) =>
      candidate.identity.remoteComputerId === remoteComputerId
      && candidate.identity.remoteEndpointId === remoteEndpointId)
    return found ? structuredClone(found.identity) : null
  }

  private commit(document: RemotePeerCredentialDocument): void {
    AtomicJsonFile.ensureDirectory(dirname(this.file))
    AtomicJsonFile.write(this.file, document)
    this.document = document
  }

  private static validDocument(value: unknown): value is RemotePeerCredentialDocument {
    if (!JsonShape.isRecord(value)
      || value.schemaVersion !== 1
      || !RemoteControlPeerIdentityValidation.isMachine(value.identity)
      || !RemotePeerCredentialStore.encoded(value.privateKey)
      || !Array.isArray(value.inboundPeers))
      return false
    const identities = new Set<string>()
    for (const candidate of value.inboundPeers) {
      if (!JsonShape.isRecord(candidate)
        || !RemoteControlPeerIdentityValidation.isPeer(candidate.identity)
        || !Number.isSafeInteger(candidate.addedAt)
        || (candidate.addedAt as number) < 0)
        return false
      const identity = candidate.identity as RemoteControlPeerIdentity
      const key = `${identity.remoteComputerId}\u0000${identity.remoteEndpointId}`
      if (identities.has(key)) return false
      identities.add(key)
    }
    return true
  }



  private static sameMachineIdentity(
    first: RemoteControlMachineIdentity,
    second: RemoteControlMachineIdentity,
  ): boolean {
    return first.remoteComputerId === second.remoteComputerId
      && first.displayName === second.displayName
      && first.signing.algorithm === second.signing.algorithm
      && first.signing.publicKey === second.signing.publicKey
      && first.signing.fingerprint === second.signing.fingerprint
  }



  private static encoded(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{32,4096}$/.test(value)
  }
}
