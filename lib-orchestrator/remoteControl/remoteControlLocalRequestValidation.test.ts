import { describe, expect, it } from 'vitest'

import { RemoteControlPeerKeys } from './remoteControlPeerKeys'
import { RemoteControlPairing } from './remoteControlPairing'
import { RemoteControlConst } from './remoteControlProtocol'
import { RemoteControlLocalRequestValidation } from './remoteControlLocalRequestValidation'

describe('lib-orchestrator/remoteControl/remoteControlLocalRequestValidation', () => {
  it('accepts the three exact local operations and normalizes a pairing bundle', () => {
    const keyPair = RemoteControlPeerKeys.generateSigningKeyPair()
    const bundle = RemoteControlPairing.bundle({
      remoteComputerId: 'computer-b',
      remoteEndpointId: 'endpoint-b',
      configIdentity: 'config-b',
      runtimeChannel: 'development',
      displayName: 'Computer B',
      signing: {
        algorithm: 'ed25519',
        publicKey: keyPair.publicKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(keyPair.publicKey),
      },
    }, { host: 'computer-b.lan', port: 47_150 })

    expect(RemoteControlLocalRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'list-1',
      operation: 'remote.computers.list',
      body: {},
    })).toMatchObject({ ok: true, request: { operation: 'remote.computers.list' } })
    expect(RemoteControlLocalRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'export-1',
      operation: 'remote.pairing.export',
      body: {},
    })).toMatchObject({ ok: true, request: { operation: 'remote.pairing.export' } })
    expect(RemoteControlLocalRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'import-1',
      operationId: 'operation-1',
      operation: 'remote.pairing.import',
      body: { bundle },
    })).toMatchObject({
      ok: true,
      request: { operation: 'remote.pairing.import', body: { bundle } },
    })
  })

  /**
   * The import body is the bundle and nothing else. `enabled` and `role` were the two vocabularies
   * for a right this operation no longer hands out, and both are now unknown fields: what the other
   * computer may do here is decided at that computer, so nothing on this wire can ask for it.
   */
  it('refuses a body still carrying the old enabled flag or role word', () => {
    const bundle = RemoteControlPairing.bundle(
      RemoteControlLocalRequestValidationTest.identity(),
      { host: '127.0.0.1', port: 47_150 },
    )
    const base = {
      protocol: RemoteControlConst.protocol,
      requestId: 'import-1',
      operationId: 'operation-1',
      operation: 'remote.pairing.import',
    }

    expect(RemoteControlLocalRequestValidation.parse({ ...base, body: { bundle } }))
      .toMatchObject({ ok: true, request: { body: { bundle } } })

    for (const body of [{ bundle, role: 'both' }, { bundle, enabled: false }])
      expect(RemoteControlLocalRequestValidation.parse({ ...base, body })).toMatchObject({
        ok: false,
        error: { code: 'invalid-request', detail: expect.stringContaining('unknown field') },
      })
  })

  it('rejects unknown fields, malformed bundles and missing mutation ids', () => {
    const base = {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'remote.pairing.import',
    }
    expect(RemoteControlLocalRequestValidation.parse({
      ...base,
      body: { bundle: {} },
    })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(RemoteControlLocalRequestValidation.parse({
      ...base,
      operationId: 'operation-1',
      body: { bundle: {}, extra: true },
    })).toMatchObject({ ok: false, error: { detail: expect.stringContaining('unknown field') } })
  })

  /*
   * The cases above are refused before the bundle is ever looked at - one for a missing operationId,
   * one for an extra field - so nothing reached the parser that decides whether a stranger's
   * identity is well formed. These carry a complete envelope and nothing but the bundle wrong.
   */
  it('reaches the bundle parser when the envelope is otherwise complete', () => {
    const bundle = RemoteControlPairing.bundle(
      RemoteControlLocalRequestValidationTest.identity(),
      { host: '127.0.0.1', port: 47_150 },
    )
    const cases: unknown[] = [
      {},
      { ...bundle, protocol: 'appjamat-v2-peer.v1' },
      { ...bundle, identity: { ...bundle.identity, signing: { ...bundle.identity.signing, fingerprint: 'a'.repeat(43) } } },
      { ...bundle, endpoint: { host: '127.0.0.1', port: 0 } },
      { ...bundle, extraField: true },
    ]

    for (const broken of cases)
      expect(RemoteControlLocalRequestValidation.parse({
        protocol: RemoteControlConst.protocol,
        requestId: 'request-1',
        operation: 'remote.pairing.import',
        operationId: 'operation-1',
        body: { bundle: broken },
      })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    expect(RemoteControlLocalRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'remote.pairing.import',
      operationId: 'operation-1',
      body: { bundle },
    }).ok).toBe(true)
  })
})

class RemoteControlLocalRequestValidationTest {
  static identity(): Parameters<typeof RemoteControlPairing.bundle>[0] {
    const keyPair = RemoteControlPeerKeys.generateSigningKeyPair()
    return {
      remoteComputerId: 'computer-b',
      remoteEndpointId: 'endpoint-b',
      configIdentity: 'config-b',
      runtimeChannel: 'development',
      displayName: 'Computer B',
      signing: {
        algorithm: 'ed25519',
        publicKey: keyPair.publicKey,
        fingerprint: RemoteControlPeerKeys.fingerprint(keyPair.publicKey),
      },
    }
  }
}
