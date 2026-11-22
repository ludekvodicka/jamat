import { readFile } from 'node:fs/promises'
import { JsonShape } from '../../shared/jsonShape'
import type { IdentityProbe } from '../profiles/profileShareTable'

/**
 * Reads the signed-in Antigravity CLI account identity (`email` and optional `planTier`) recorded
 * from `agy`'s `statusLine` JSON payload by `AntigravityStatusLine`. Never reads OS credentials or
 * auth tokens.
 */
export class AntigravityIdentityProbe {
  async read(accountFile: string): Promise<IdentityProbe | null> {
    let raw: string
    try { raw = await readFile(accountFile, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return { kind: 'failed', reason: 'Antigravity account metadata is unreadable' }
    }
    return AntigravityIdentityProbe.parse(raw)
  }

  static parse(raw: string): IdentityProbe | null {
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { return { kind: 'failed', reason: 'Antigravity account metadata is unreadable' } }
    const record = JsonShape.record(parsed)
    if (record === null || record.schemaVersion !== 1) return null
    const email = typeof record.email === 'string' && record.email.trim().length > 0 ? record.email.trim() : null
    const planTier = typeof record.planTier === 'string' && record.planTier.trim().length > 0 ? record.planTier.trim() : null
    if (email === null) return null
    return {
      kind: 'logged-in',
      identity: { key: `antigravity/${email.toLowerCase()}`, label: email },
      ...(planTier === null ? {} : { rateLimitTier: planTier }),
    }
  }
}
