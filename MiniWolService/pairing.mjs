import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isIPv4 } from 'node:net'

export class LauncherInvitations {
  /** @type {Map<string, {token: Buffer, expiresAt: number, launcher: import('./launcher.mjs').LauncherConfig}>} */
  invitations

  constructor() {
    this.invitations = new Map()
  }

  /** @param {string} id @param {import('./launcher.mjs').LauncherConfig} launcher */
  issue(id, launcher) {
    this.prune()
    const token = randomBytes(32)
    this.invitations.set(id, { token, expiresAt: Date.now() + 5 * 60 * 1000, launcher })
    return token.toString('hex')
  }

  /** @param {string} token @param {string | undefined} remoteAddress */
  redeem(token, remoteAddress) {
    this.prune()
    const address = remoteAddress?.replace(/^::ffff:/i, '')
    if (!address || !isIPv4(address) || !/^[0-9a-f]{64}$/.test(token))
      return undefined
    for (const [id, invitation] of this.invitations) {
      if (!timingSafeEqual(invitation.token, Buffer.from(token, 'hex')))
        continue
      if (address !== new URL(invitation.launcher.url).hostname)
        return undefined
      // No await between validation and deletion: concurrent redeems cannot both succeed.
      this.invitations.delete(id)
      return invitation.launcher
    }
    return undefined
  }

  prune() {
    for (const [id, invitation] of this.invitations)
      if (invitation.expiresAt <= Date.now())
        this.invitations.delete(id)
  }
}

/** @param {import('node:http').IncomingMessage} request @returns {Promise<string>} */
export function readPairingToken(request) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let length = 0
    const timeout = setTimeout(fail, 3000)
    function cleanup() {
      clearTimeout(timeout)
      request.off('data', data)
      request.off('end', end)
      request.off('aborted', fail)
    }
    function fail() {
      cleanup()
      request.pause()
      reject(new Error('Invalid pairing request'))
    }
    /** @param {Buffer} chunk */
    function data(chunk) {
      length += chunk.length
      if (length > 1024)
        return fail()
      chunks.push(chunk)
    }
    function end() {
      cleanup()
      try {
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
          || typeof body.token !== 'string' || !/^[0-9a-f]{64}$/.test(body.token))
          throw new Error('Invalid pairing request')
        resolve(body.token)
      } catch {
        reject(new Error('Invalid pairing request'))
      }
    }
    request.on('data', data)
    request.once('end', end)
    request.once('error', fail)
    request.once('aborted', fail)
  })
}
