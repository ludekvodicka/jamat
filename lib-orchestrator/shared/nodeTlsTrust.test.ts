import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'
import { describe, expect, it } from 'vitest'

import roots from './nodeTlsTrust.fixture.json'
import { NodeTlsTrust } from './nodeTlsTrust'

describe('NodeTlsTrust', () => {
  it('removes every incident trust anchor while preserving unrelated default certificates', () => {
    const unaffected = tls.rootCertificates.filter(pem => !new X509Certificate(pem).subject.includes('emSign'))
    const trusted = NodeTlsTrust.certificates([...unaffected, ...roots.map(root => root.pem)])
    expect(trusted).toEqual(unaffected)
    for (const root of roots)
      expect(NodeTlsTrust.certificates([root.pem]), root.name).toEqual([])
  })

  it('rejects malformed trust inputs instead of silently retaining them', () => {
    expect(() => NodeTlsTrust.certificates(['invalid certificate'])).toThrow()
  })

  it('replaces real Node defaults, including incident roots added to the default set', () => {
    const runtime = tls as typeof tls & { setDefaultCACertificates(certificates: string[]): void }
    const previous = tls.getCACertificates('default')
    const fingerprints = (certificates: string[]) => certificates
      .map(pem => new X509Certificate(pem).fingerprint256).sort()
    try {
      runtime.setDefaultCACertificates([...previous, ...roots.map(root => root.pem)])
      NodeTlsTrust.install()
      expect(fingerprints(tls.getCACertificates('default')))
        .toEqual(fingerprints(NodeTlsTrust.certificates(previous)))
      NodeTlsTrust.install()
      expect(fingerprints(tls.getCACertificates('default')))
        .toEqual(fingerprints(NodeTlsTrust.certificates(previous)))
    } finally { runtime.setDefaultCACertificates(previous) }
  })
})
