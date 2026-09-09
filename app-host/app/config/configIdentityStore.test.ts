import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigIdentityStore } from './configIdentityStore.js'

describe('app-host/app/config/configIdentityStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryConfigDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-identity-'))
    created.push(directory)
    return directory
  }

  it('creates the identity document on first load', () => {
    const configDir = temporaryConfigDir()
    const identity = ConfigIdentityStore.loadOrCreate(configDir, 'development')
    expect(existsSync(join(configDir, 'config-identity.json'))).toBe(true)
    expect(identity.schemaVersion).toBe(1)
    expect(identity.runtimeChannel).toBe('development')
    expect(identity.configIdentity).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('returns the same identity on a second load', () => {
    const configDir = temporaryConfigDir()
    const first = ConfigIdentityStore.loadOrCreate(configDir, 'development')
    const second = ConfigIdentityStore.loadOrCreate(configDir, 'development')
    expect(second.configIdentity).toBe(first.configIdentity)
    expect(second.createdAt).toBe(first.createdAt)
  })

  // Two channels sharing one config directory would share one identity, and with it one Host lock.
  it('refuses a channel that disagrees with the stored identity', () => {
    const configDir = temporaryConfigDir()
    ConfigIdentityStore.loadOrCreate(configDir, 'development')
    expect(() => ConfigIdentityStore.loadOrCreate(configDir, 'production'))
      .toThrow(/Config channel mismatch/)
  })

  it('reads an existing identity without creating one', () => {
    const configDir = temporaryConfigDir()
    const created = ConfigIdentityStore.loadOrCreate(configDir, 'production')
    expect(ConfigIdentityStore.readFrom(configDir).configIdentity).toBe(created.configIdentity)
  })

  it('throws instead of creating when readFrom finds no identity', () => {
    const configDir = temporaryConfigDir()
    expect(() => ConfigIdentityStore.readFrom(configDir)).toThrow()
    expect(existsSync(join(configDir, 'config-identity.json'))).toBe(false)
  })

  it('rejects a document with an unsupported schema version', () => {
    const configDir = temporaryConfigDir()
    ConfigIdentityStore.loadOrCreate(configDir, 'development')
    const file = join(configDir, 'config-identity.json')
    const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    document.schemaVersion = 2
    rmSync(file, { force: true })
    writeFileSync(file, JSON.stringify(document, null, 2), 'utf8')
    expect(() => ConfigIdentityStore.readFrom(configDir)).toThrow(/Unsupported config identity schema/)
  })
})
