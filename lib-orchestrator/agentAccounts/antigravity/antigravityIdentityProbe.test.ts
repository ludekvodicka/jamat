import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityIdentityProbe } from './antigravityIdentityProbe'

describe('lib-orchestrator/agentAccounts/antigravity/antigravityIdentityProbe', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  it('parses email and optional planTier and returns null when unobserved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-agy-id-'))
    roots.push(root)
    const file = join(root, 'antigravity-account.json')
    const probe = new AntigravityIdentityProbe()

    expect(await probe.read(file)).toBeNull()

    writeFileSync(file, JSON.stringify({ schemaVersion: 1, email: 'User@Example.com', planTier: 'Pro' }))
    expect(await probe.read(file)).toEqual({
      kind: 'logged-in',
      identity: { key: 'antigravity/user@example.com', label: 'User@Example.com' },
      rateLimitTier: 'Pro',
    })

    writeFileSync(file, '{broken')
    expect(await probe.read(file)).toMatchObject({ kind: 'failed' })
  })
})
