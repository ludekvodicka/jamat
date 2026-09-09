import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteControlPairing } from '../../../lib-orchestrator/remoteControl/remoteControlPairing'
import { RemoteEndpointIdentityStore } from './remoteEndpointIdentityStore'
import {
  RemoteControlPairingManager,
  type RemoteControlPairingConfirmRequest,
} from './remoteControlPairingManager'
import { RemoteControlSettingsSection } from './remoteControlSettingsSection'
import { RemotePeerCredentialStore } from './remotePeerCredentialStore'

describe('app-client-ui/app/remoteControl/remoteControlPairingManager', () => {
  const roots: string[] = []
  const servers: PairingBundleServer[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const serve = async (text: string | null): Promise<PairingBundleServer> => {
    const server = await PairingBundleServer.start(text)
    servers.push(server)
    return server
  }

  it('publishes a public bundle and keeps it for the copy button', () => {
    const local = RemoteControlPairingManagerTest.side(roots, 'local')
    const manager = RemoteControlPairingManagerTest.manager(local, () => Promise.resolve(true))

    const published = manager.publish({ host: 'local.lan', port: 47_150 })

    const publicText = readFileSync(local.bundleFile, 'utf8')
    expect(publicText).toContain(local.identity.signing.publicKey)
    expect(publicText).not.toContain('privateKey')
    expect(publicText).not.toContain('token')
    expect(published.endpoint).toEqual({ host: 'local.lan', port: 47_150 })
    expect(manager.bundle()).toEqual(published)
  })

  /**
   * The 2026-09-07 shape of an import: ONE store moves. Reaching in here is the other computer's own
   * dialog to answer, so a pairing that writes inbound trust on this side is exactly the thing this
   * test exists to notice.
   */
  it('pairs a pasted bundle into the config section alone and writes no trust', async () => {
    const local = RemoteControlPairingManagerTest.side(roots, 'local')
    const remote = RemoteControlPairingManagerTest.side(roots, 'remote')
    const asked: RemoteControlPairingConfirmRequest[] = []
    const credentials = new SpyCredentials(local.credentials)
    const manager = RemoteControlPairingManagerTest.manager(local, (request) => {
      asked.push(request)
      return Promise.resolve(true)
    }, credentials)
    const bundle = RemoteControlPairing.bundle(remote.identity, { host: 'remote.lan', port: 47_151 })

    expect(await manager.import(bundle)).toMatchObject({ ok: true, value: { profileId: expect.any(String) } })

    expect(credentials.writes).toEqual([])
    expect(local.credentials.trustedInbound(
      remote.identity.remoteComputerId,
      remote.identity.remoteEndpointId,
    )).toBeNull()
    // The person is told where the key came from, not merely that a pairing happened.
    expect(asked).toEqual([{
      remoteComputerId: remote.identity.remoteComputerId,
      remoteEndpointId: remote.identity.remoteEndpointId,
      displayName: remote.identity.displayName,
      fingerprint: remote.identity.signing.fingerprint,
      source: 'bundle',
    }])
    const settings = local.config.readSection(RemoteControlSettingsSection.spec)
    expect(settings.profiles).toHaveLength(1)
    expect(settings.profiles[0]?.remoteEndpointId).toBe(remote.identity.remoteEndpointId)
  })

  /** Typing an address is the same pairing, with the bundle fetched instead of pasted. */
  it('pairs a typed address from the bundle that address serves', async () => {
    const local = RemoteControlPairingManagerTest.side(roots, 'local')
    const remote = RemoteControlPairingManagerTest.side(roots, 'remote')
    const asked: RemoteControlPairingConfirmRequest[] = []
    const credentials = new SpyCredentials(local.credentials)
    const manager = RemoteControlPairingManagerTest.manager(local, (request) => {
      asked.push(request)
      return Promise.resolve(true)
    }, credentials)
    const served = await serve(JSON.stringify(
      RemoteControlPairing.bundle(remote.identity, { host: 'remote.lan', port: 47_151 }),
    ))

    const imported = await manager.importFromAddress(served.endpoint())

    expect(imported).toMatchObject({ ok: true, value: { profileId: expect.any(String) } })
    // The one thing that differs from a paste, and the one thing the dialog says out loud.
    expect(asked.map((request) => request.source)).toEqual(['address'])
    expect(asked[0]?.fingerprint).toBe(remote.identity.signing.fingerprint)
    expect(credentials.writes).toEqual([])
    const settings = local.config.readSection(RemoteControlSettingsSection.spec)
    expect(settings.profiles[0]?.pinnedIdentity).toEqual(remote.identity.signing)
  })

  it('refuses an address that answers with no pairing info, without asking anybody', async () => {
    const local = RemoteControlPairingManagerTest.side(roots, 'local')
    const asked: string[] = []
    const manager = RemoteControlPairingManagerTest.manager(local, (request) => {
      asked.push(request.fingerprint)
      return Promise.resolve(true)
    })
    const silent = await serve(null)

    const refused = await manager.importFromAddress(silent.endpoint())

    expect(refused).toMatchObject({ ok: false, code: 'probe-failed' })
    expect(asked).toEqual([])
    expect(local.config.readSection(RemoteControlSettingsSection.spec).profiles).toEqual([])
  })

  /**
   * The gate itself. Trusting another machine used to be an ordinary local operation behind the same
   * bearer token as `sessions.list`, so an agent told to import a bundle - by a README, an issue, or
   * the output of a terminal it was reading - handed a stranger this computer, with one audit line
   * as the only trace.
   */
  it('writes nothing when the person refuses the pairing', async () => {
    let confirmed = false
    const local = RemoteControlPairingManagerTest.side(roots, 'local')
    const remote = RemoteControlPairingManagerTest.side(roots, 'remote')
    const asked: string[] = []
    const manager = RemoteControlPairingManagerTest.manager(local, (request) => {
      asked.push(request.fingerprint)
      return Promise.resolve(confirmed)
    })
    const bundle = RemoteControlPairing.bundle(remote.identity, { host: 'remote.lan', port: 1 })

    const refused = await manager.import(bundle)

    expect(refused).toMatchObject({ ok: false, code: 'not-confirmed' })
    // The fingerprint is what the two people compare out of band, so it has to reach the question.
    expect(asked).toEqual([remote.identity.signing.fingerprint])
    expect(local.config.readSection(RemoteControlSettingsSection.spec).profiles).toEqual([])

    // And the same bundle goes through once the person says yes.
    confirmed = true
    expect((await manager.import(bundle)).ok).toBe(true)
    expect(local.config.readSection(RemoteControlSettingsSection.spec).profiles).toHaveLength(1)
  })

  it('refuses a pinned key change without replacing the stored profile', async () => {
    const local = RemoteControlPairingManagerTest.side(roots, 'local')
    const first = RemoteControlPairingManagerTest.side(roots, 'remote-a')
    const changed = RemoteControlPairingManagerTest.side(roots, 'remote-b')
    const manager = RemoteControlPairingManagerTest.manager(local, () => Promise.resolve(true))
    const firstBundle = RemoteControlPairing.bundle(first.identity, { host: 'remote.lan', port: 1 })
    expect((await manager.import(firstBundle)).ok).toBe(true)

    const changedBundle = RemoteControlPairing.bundle(
      RemoteControlPairingManagerTest.wearing(changed.identity, first.identity),
      { host: 'remote.lan', port: 2 },
    )

    expect(await manager.import(changedBundle)).toMatchObject({
      ok: false,
      code: 'identity-conflict',
    })
    const settings = local.config.readSection(RemoteControlSettingsSection.spec)
    expect(settings.profiles[0]?.pinnedIdentity).toEqual(first.identity.signing)
  })

  /**
   * The two directions are independent now, which is precisely why an outbound pin still may not
   * contradict an inbound one: the same computer under two different keys is one of them lying.
   */
  it('refuses a bundle whose identity is already trusted inbound under another key', async () => {
    const local = RemoteControlPairingManagerTest.side(roots, 'local')
    const allowed = RemoteControlPairingManagerTest.side(roots, 'remote-a')
    const changed = RemoteControlPairingManagerTest.side(roots, 'remote-b')
    local.credentials.trustInbound(allowed.identity)
    const manager = RemoteControlPairingManagerTest.manager(local, () => Promise.resolve(true))

    const refused = await manager.import(RemoteControlPairing.bundle(
      RemoteControlPairingManagerTest.wearing(changed.identity, allowed.identity),
      { host: 'remote.lan', port: 1 },
    ))

    expect(refused).toMatchObject({ ok: false, code: 'identity-conflict' })
    expect(local.config.readSection(RemoteControlSettingsSection.spec).profiles).toEqual([])
    expect(local.credentials.trustedInbound(
      allowed.identity.remoteComputerId,
      allowed.identity.remoteEndpointId,
    )?.signing).toEqual(allowed.identity.signing)
  })
})

/** Proves what the manager does NOT do: the two trust writes are here and are never reached. */
class SpyCredentials {
  readonly writes: string[] = []

  constructor(private readonly store: RemotePeerCredentialStore) {}

  assertInboundIdentity(identity: RemoteControlPeerIdentity): void {
    this.store.assertInboundIdentity(identity)
  }

  trustInbound(identity: RemoteControlPeerIdentity): void {
    this.writes.push(`trust ${identity.remoteEndpointId}`)
  }

  revokeInbound(remoteComputerId: string, remoteEndpointId: string): void {
    this.writes.push(`revoke ${remoteComputerId}/${remoteEndpointId}`)
  }
}

class PairingBundleServer {
  private constructor(private readonly server: Server) {}

  /** `null` serves nothing at all, which is what an address with no listener behind it looks like. */
  static start(text: string | null): Promise<PairingBundleServer> {
    return new Promise((resolve, reject) => {
      const server = createServer((_request, response) => {
        if (text === null) {
          response.writeHead(404, { 'Content-Length': '0' })
          response.end()
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(text)
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(new PairingBundleServer(server)))
    })
  }

  endpoint(): RemoteControlPeerEndpoint {
    const address = this.server.address()
    if (address === null || typeof address === 'string')
      throw new Error('The pairing test server has no port')
    return { host: '127.0.0.1', port: address.port }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections()
      this.server.close(() => resolve())
    })
  }
}

class RemoteControlPairingManagerTest {
  static side(roots: string[], name: string) {
    const root = mkdtempSync(join(tmpdir(), `jamat-v3-pairing-${name}-`))
    roots.push(root)
    const credentials = RemotePeerCredentialStore.loadOrCreate(
      join(root, 'credentials.json'),
      join(root, 'machine.json'),
      {
        computerId: () => `computer-${name}`,
        displayName: () => `Computer ${name}`,
        keyPair: () => RemoteControlPeerKeys.generateSigningKeyPair(),
      },
    )
    const identity = RemoteEndpointIdentityStore.loadOrCreate(
      join(root, 'endpoint.json'),
      credentials.machineIdentity(),
      `config-${name}`,
      'development',
      () => `endpoint-${name}`,
    ).identity(credentials.machineIdentity())
    return {
      root,
      credentials,
      identity,
      config: ConfigStore.load(root, { snapshotsDirectory: join(root, 'snapshots') }),
      bundleFile: join(root, 'pairing.json'),
    }
  }

  static manager(
    local: ReturnType<typeof RemoteControlPairingManagerTest.side>,
    confirm: (request: RemoteControlPairingConfirmRequest) => Promise<boolean>,
    credentials: Pick<RemotePeerCredentialStore, 'assertInboundIdentity'> = local.credentials,
  ): RemoteControlPairingManager {
    return new RemoteControlPairingManager(
      local.config,
      credentials,
      local.identity,
      local.bundleFile,
      confirm,
    )
  }

  /** The same computer, said by a machine holding another key: names and ids kept, signing swapped. */
  static wearing(
    signer: RemoteControlPeerIdentity,
    named: RemoteControlPeerIdentity,
  ): RemoteControlPeerIdentity {
    return {
      ...signer,
      remoteComputerId: named.remoteComputerId,
      remoteEndpointId: named.remoteEndpointId,
      configIdentity: named.configIdentity,
    }
  }
}
