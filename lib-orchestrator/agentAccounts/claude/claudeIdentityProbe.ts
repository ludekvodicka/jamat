import { lstatSync, readFileSync } from 'node:fs'
import { ErrnoCode } from '../../shared/errnoCode'
import { JsonShape } from '../../shared/jsonShape'
import type { IdentityProbe } from '../profiles/profileShareTable'

export class ClaudeIdentityProbe {
  async read(file: string): Promise<IdentityProbe> {
    try {
      if (!lstatSync(file).isFile()) return { kind: 'failed', reason: 'Claude identity metadata must be a regular file' }
      return ClaudeIdentityProbe.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return { kind: 'logged-out' }
      return { kind: 'failed', reason: 'Claude identity metadata could not be read' }
    }
  }

  static parse(text: string): IdentityProbe {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return { kind: 'failed', reason: 'Claude identity metadata is not JSON' } }
    if (!JsonShape.isRecord(raw)) return { kind: 'failed', reason: 'Invalid Claude identity metadata' }
    if (raw.oauthAccount === undefined || raw.oauthAccount === null) return { kind: 'logged-out' }
    const account = raw.oauthAccount
    if (JsonShape.isRecord(account) && typeof account.emailAddress === 'string' && account.emailAddress.trim()
      && typeof account.organizationUuid === 'string' && account.organizationUuid.trim())
      return { kind: 'logged-in', identity: { key: `${account.organizationUuid}/${account.emailAddress}`, label: account.emailAddress } }
    return { kind: 'failed', reason: 'Claude identity metadata has no account identity' }
  }
}
