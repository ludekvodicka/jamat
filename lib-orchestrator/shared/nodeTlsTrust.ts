import { createHash, X509Certificate } from 'node:crypto'
import tls from 'node:tls'

export class NodeTlsTrust {
  // Node's native intermediate-key blocklist is not yet in a released plain Node runtime.
  // Remove the four incident trust anchors by key, including alternate certificates for each key.
  // Source: https://emudhra.we-have-a-problem.com/roots.json
  private static readonly blockedKeys = new Set([
    'c619e4780ed8e0abeda24ad732567de4383a7ea941338f6d1a7d1b49ac792fe9',
    '0a6c2b2ca5b364207954171987ac9d2178561569d8205457e77ca90c32ede282',
    'bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3',
    '8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782',
  ])

  static certificates(certificates: readonly string[]): string[] {
    return certificates.filter(pem => {
      const key = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
      return !NodeTlsTrust.blockedKeys.has(createHash('sha256').update(key).digest('hex'))
    })
  }

  static install(): void {
    // The runtime API postdates this project's Node type declarations (added in Node 22.19).
    const runtime = tls as typeof tls & { setDefaultCACertificates?: (certificates: string[]) => void }
    if (typeof runtime.setDefaultCACertificates !== 'function')
      throw new Error('Jamat TLS policy requires Node 22.19 or newer')
    runtime.setDefaultCACertificates(NodeTlsTrust.certificates(tls.getCACertificates('default')))
  }
}
