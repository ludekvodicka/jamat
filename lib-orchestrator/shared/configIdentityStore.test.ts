import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeChannel } from './configIdentity.types'
import { ConfigIdentityStore } from './configIdentityStore'

describe('lib-orchestrator/shared/configIdentityStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryConfigDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-lib-identity-'))
    created.push(directory)
    return directory
  }

  /**
   * The losing interleaving (both callers past their existence check) cannot be produced from one
   * process through the public entry, so the test drives the creation step the way a second process
   * would reach it.
   */
  function createExclusive(configDir: string, channel: RuntimeChannel): void {
    const store = ConfigIdentityStore as unknown as {
      createExclusive(file: string, channel: RuntimeChannel): void
    }
    store.createExclusive(join(configDir, 'config-identity.json'), channel)
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

  // The Host writes the same file in the same directory: a second creation must never replace a
  // published document, and the loser must read the winner's, not its own.
  it('keeps the winner document when a second creation races it', () => {
    const configDir = temporaryConfigDir()
    const winner = ConfigIdentityStore.loadOrCreate(configDir, 'development')
    createExclusive(configDir, 'development')
    const loser = ConfigIdentityStore.loadOrCreate(configDir, 'development')
    expect(loser.configIdentity).toBe(winner.configIdentity)
    expect(loser.createdAt).toBe(winner.createdAt)
    expect(readdirSync(configDir)).toEqual(['config-identity.json'])
  })

  // Two channels sharing one config directory would share one identity, and with it one Host lock.
  it('refuses a channel that disagrees with the stored identity', () => {
    const configDir = temporaryConfigDir()
    ConfigIdentityStore.loadOrCreate(configDir, 'development')
    expect(() => ConfigIdentityStore.loadOrCreate(configDir, 'production'))
      .toThrow(/identity is development, launch requested production/)
  })

  it('reads the stored channel when the caller did not select one', () => {
    const configDir = temporaryConfigDir()
    const created = ConfigIdentityStore.loadOrCreate(configDir, 'production')

    expect(ConfigIdentityStore.readExisting(configDir)).toEqual(created)
    expect(ConfigIdentityStore.readExisting(join(configDir, 'missing'))).toBeNull()
  })

  it('throws instead of replacing a damaged identity file', () => {
    const configDir = temporaryConfigDir()
    ConfigIdentityStore.loadOrCreate(configDir, 'development')
    const file = join(configDir, 'config-identity.json')
    writeFileSync(file, '{ "schemaVersion": 1, "configIdentity"', 'utf8')
    expect(() => ConfigIdentityStore.loadOrCreate(configDir, 'development'))
      .toThrow(/Invalid config identity/)
    expect(existsSync(file)).toBe(true)
  })

  it('rejects an identity document with an unsupported schema version', () => {
    const configDir = temporaryConfigDir()
    ConfigIdentityStore.loadOrCreate(configDir, 'development')
    writeFileSync(
      join(configDir, 'config-identity.json'),
      JSON.stringify({ schemaVersion: 2 }),
      'utf8',
    )
    expect(() => ConfigIdentityStore.loadOrCreate(configDir, 'development'))
      .toThrow(/Unsupported config identity schema/)
  })
})
