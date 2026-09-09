import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'

export interface RemoteControlPeerSigningKeyPair {
  publicKey: string
  privateKey: string
}

export interface RemoteControlPeerEphemeralKeyPair {
  publicKey: string
  privateKey: KeyObject
}

export class RemoteControlPeerKeys {
  static generateSigningKeyPair(): RemoteControlPeerSigningKeyPair {
    const generated = generateKeyPairSync('ed25519')
    return {
      publicKey: RemoteControlPeerKeys.exportPublic(generated.publicKey),
      privateKey: RemoteControlPeerKeys.exportPrivate(generated.privateKey),
    }
  }

  static generateEphemeralKeyPair(): RemoteControlPeerEphemeralKeyPair {
    const generated = generateKeyPairSync('x25519')
    return {
      publicKey: RemoteControlPeerKeys.exportPublic(generated.publicKey),
      privateKey: generated.privateKey,
    }
  }

  static fingerprint(publicKey: string): string {
    const key = RemoteControlPeerKeys.publicKey(publicKey)
    return createHash('sha256')
      .update(key.export({ format: 'der', type: 'spki' }))
      .digest('base64url')
  }

  static publicFromPrivate(privateKey: string): string {
    return RemoteControlPeerKeys.exportPublic(createPublicKey(
      RemoteControlPeerKeys.privateKey(privateKey),
    ))
  }

  static sign(privateKey: string, payload: Buffer): string {
    return sign(null, payload, RemoteControlPeerKeys.privateKey(privateKey)).toString('base64url')
  }

  static verify(publicKey: string, payload: Buffer, signature: string): boolean {
    try {
      return verify(
        null,
        payload,
        RemoteControlPeerKeys.publicKey(publicKey),
        Buffer.from(signature, 'base64url'),
      )
    } catch {
      return false
    }
  }

  static sharedSecret(privateKey: KeyObject, remotePublicKey: string): Buffer {
    return diffieHellman({
      privateKey,
      publicKey: RemoteControlPeerKeys.publicKey(remotePublicKey),
    })
  }

  static validatePublicKey(publicKey: string): boolean {
    try {
      const key = RemoteControlPeerKeys.publicKey(publicKey)
      return key.asymmetricKeyType === 'ed25519'
    } catch {
      return false
    }
  }

  private static publicKey(encoded: string): KeyObject {
    return createPublicKey({
      key: Buffer.from(encoded, 'base64url'),
      format: 'der',
      type: 'spki',
    })
  }

  private static privateKey(encoded: string): KeyObject {
    return createPrivateKey({
      key: Buffer.from(encoded, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    })
  }

  private static exportPublic(key: KeyObject): string {
    return key.export({ format: 'der', type: 'spki' }).toString('base64url')
  }

  private static exportPrivate(key: KeyObject): string {
    return key.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  }
}
