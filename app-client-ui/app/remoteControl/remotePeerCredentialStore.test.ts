import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RemoteControlPeerIdentity } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteEndpointIdentityStore } from './remoteEndpointIdentityStore'
import { RemotePeerCredentialStore } from './remotePeerCredentialStore'

describe('app-client-ui/app/remoteControl/remotePeerCredentialStore', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  it('creates one stable machine identity and keeps its private key out of the public file', () => {
    const root = RemotePeerCredentialStoreTest.root(roots)
    const files = RemotePeerCredentialStoreTest.files(root)
    const first = RemotePeerCredentialStore.loadOrCreate(files.credentials, files.identity, {
      computerId: () => 'computer-a',
      displayName: () => 'Computer A',
    })
    const publicFile = readFileSync(files.identity, 'utf8')
    const credentialFile = readFileSync(files.credentials, 'utf8')
    expect(first.machineIdentity().remoteComputerId).toBe('computer-a')
    expect(publicFile).not.toContain('privateKey')
    expect(credentialFile).toContain('privateKey')

    const reopened = RemotePeerCredentialStore.loadOrCreate(files.credentials, files.identity)
    expect(reopened.machineIdentity()).toEqual(first.machineIdentity())
  })

  it('repairs a missing public projection but never rotates a missing private identity', () => {
    const root = RemotePeerCredentialStoreTest.root(roots)
    const files = RemotePeerCredentialStoreTest.files(root)
    const store = RemotePeerCredentialStore.loadOrCreate(files.credentials, files.identity)
    unlinkSync(files.identity)
    expect(existsSync(files.identity)).toBe(false)
    expect(RemotePeerCredentialStore.loadOrCreate(files.credentials, files.identity).machineIdentity())
      .toEqual(store.machineIdentity())

    unlinkSync(files.credentials)
    expect(() => RemotePeerCredentialStore.loadOrCreate(files.credentials, files.identity))
      .toThrow('private key is missing')
  })

  it('pins an inbound endpoint and refuses a key change under the same identity', () => {
    const targetRoot = RemotePeerCredentialStoreTest.root(roots)
    const sourceRoot = RemotePeerCredentialStoreTest.root(roots)
    const targetFiles = RemotePeerCredentialStoreTest.files(targetRoot)
    const sourceFiles = RemotePeerCredentialStoreTest.files(sourceRoot)
    const target = RemotePeerCredentialStore.loadOrCreate(targetFiles.credentials, targetFiles.identity)
    const source = RemotePeerCredentialStore.loadOrCreate(sourceFiles.credentials, sourceFiles.identity)
    const endpoint = RemoteEndpointIdentityStore.loadOrCreate(
      join(sourceRoot, 'endpoint.json'),
      source.machineIdentity(),
      'config-a',
      'development',
      () => 'endpoint-a',
    )
    const identity = endpoint.identity(source.machineIdentity())
    target.trustInbound(identity, 123)
    expect(target.trustedInbound(identity.remoteComputerId, identity.remoteEndpointId)).toEqual(identity)
    // The file is the record, so that is where the trust is read back from.
    const stored: unknown = JSON.parse(readFileSync(targetFiles.credentials, 'utf8'))
    expect(stored).toMatchObject({ inboundPeers: [{ addedAt: 123 }] })

    const otherKey = RemoteControlPeerKeys.generateSigningKeyPair().publicKey
    const changed: RemoteControlPeerIdentity = {
      ...identity,
      signing: {
        algorithm: 'ed25519',
        publicKey: otherKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(otherKey),
      },
    }
    expect(() => target.trustInbound(changed)).toThrow('another identity')
    target.revokeInbound(identity.remoteComputerId, identity.remoteEndpointId)
    expect(target.trustedInbound(identity.remoteComputerId, identity.remoteEndpointId)).toBeNull()
  })

  /**
   * What the "Allowed in" list is drawn from. It is a projection of the one file that also holds
   * this machine's private key, so the two things worth proving are that it carries nothing of the
   * key and that a caller cannot reach back into the document through what it was handed.
   */
  it('lists every computer allowed in as a clone, carrying nothing of the private key', () => {
    const targetRoot = RemotePeerCredentialStoreTest.root(roots)
    const sourceRoot = RemotePeerCredentialStoreTest.root(roots)
    const targetFiles = RemotePeerCredentialStoreTest.files(targetRoot)
    const sourceFiles = RemotePeerCredentialStoreTest.files(sourceRoot)
    const target = RemotePeerCredentialStore.loadOrCreate(targetFiles.credentials, targetFiles.identity)
    const source = RemotePeerCredentialStore.loadOrCreate(sourceFiles.credentials, sourceFiles.identity)
    const identity = RemoteEndpointIdentityStore.loadOrCreate(
      join(sourceRoot, 'endpoint.json'),
      source.machineIdentity(),
      'config-a',
      'development',
      () => 'endpoint-a',
    ).identity(source.machineIdentity())
    expect(target.inboundPeers()).toEqual([])

    target.trustInbound(identity, 123)

    const listed = target.inboundPeers()
    expect(listed).toEqual([{ identity, addedAt: 123 }])
    const stored: unknown = JSON.parse(readFileSync(targetFiles.credentials, 'utf8'))
    const privateKey = (stored as { privateKey: string }).privateKey
    expect(JSON.stringify(listed)).not.toContain(privateKey)
    expect(JSON.stringify(listed)).not.toContain('privateKey')

    // A clone, so the list a screen was handed cannot rewrite what this computer lets in.
    const first = listed[0]
    if (first === undefined) throw new Error('The listed peer disappeared')
    first.identity.displayName = 'Somebody else'
    expect(target.inboundPeers()[0]?.identity.displayName).toBe(identity.displayName)
  })

  it('keeps endpoint IDs stable per config and distinct between configs', () => {
    const root = RemotePeerCredentialStoreTest.root(roots)
    const files = RemotePeerCredentialStoreTest.files(root)
    const machine = RemotePeerCredentialStore.loadOrCreate(files.credentials, files.identity)
      .machineIdentity()
    const firstFile = join(root, 'first-endpoint.json')
    const first = RemoteEndpointIdentityStore.loadOrCreate(
      firstFile,
      machine,
      'config-a',
      'development',
      () => 'endpoint-a',
    )
    const reopened = RemoteEndpointIdentityStore.loadOrCreate(
      firstFile,
      machine,
      'config-a',
      'development',
      () => 'wrong-new-id',
    )
    const second = RemoteEndpointIdentityStore.loadOrCreate(
      join(root, 'second-endpoint.json'),
      machine,
      'config-b',
      'development',
      () => 'endpoint-b',
    )
    expect(reopened.identity(machine)).toEqual(first.identity(machine))
    expect(second.identity(machine).remoteEndpointId).not.toBe(first.identity(machine).remoteEndpointId)
  })
})

class RemotePeerCredentialStoreTest {
  static root(roots: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-peer-credentials-test-'))
    roots.push(root)
    return root
  }

  static files(root: string): { credentials: string; identity: string } {
    return {
      credentials: join(root, 'credentials.json'),
      identity: join(root, 'identity.json'),
    }
  }
}
