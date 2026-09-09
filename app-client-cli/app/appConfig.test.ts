import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'
import { AppClientCliError } from './appClientCliError'
import { AppConfig } from './appConfig'
import { CliArguments } from './cliArguments'

describe('app-client-cli/app/appConfig', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('resolves an explicit config independently of cwd and reads its channel identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-cli-config-'))
    roots.push(root)
    ConfigIdentityStore.loadOrCreate(root, 'production')

    const config = AppConfig.load(CliArguments.parse([
      'status',
      '--config-dir', root,
      '--channel', 'production',
    ]), {})

    expect(config.configDir).toBe(root)
    expect(config.runtimeChannel).toBe('production')
    expect(config.identity).toMatchObject({
      schemaVersion: 1,
      runtimeChannel: 'production',
    })
  })

  it('takes production from an explicit config directory when no channel was selected', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-cli-config-channel-'))
    roots.push(root)
    ConfigIdentityStore.loadOrCreate(root, 'production')

    const config = AppConfig.load(CliArguments.parse(['status', '--config-dir', root]), {})

    expect(config.runtimeChannel).toBe('production')
    expect(config.configIdentity).toBe(config.identity?.configIdentity)
    expect(() => AppConfig.load(CliArguments.parse([
      'status', '--config-dir', root, '--channel', 'development',
    ]), {})).toThrow(/identity is production, launch requested development/)
  })

  it('returns auto-discovery filters when no strict config source exists', () => {
    const automatic = AppConfig.load(CliArguments.parse(['status']), {})
    const filtered = AppConfig.load(CliArguments.parse([
      'status',
      '--config-identity', 'identity-a',
      '--channel', 'production',
    ]), {})

    expect(automatic).toMatchObject({
      configDir: null,
      configIdentity: null,
      runtimeChannel: null,
      identity: null,
    })
    expect(filtered).toMatchObject({
      configDir: null,
      configIdentity: 'identity-a',
      runtimeChannel: 'production',
      identity: null,
    })
  })

  /*
   * This CLI owns no durable state. Creating the identity it went looking for answered its own
   * question: a mistyped `--config-dir` made a fresh identity nobody publishes under, and the run
   * then reported, correctly and uselessly, that no AppClientUI was running there.
   */
  it('refuses a config directory no AppClientUI has ever used, and writes nothing into it', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-cli-empty-'))
    roots.push(root)
    const missing = join(root, 'never-used')

    expect(() => AppConfig.load(CliArguments.parse([
      'status',
      '--config-dir', missing,
    ]), {})).toThrow(AppClientCliError)

    expect(existsSync(missing)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('uses only JAMAT_V3 variables and rejects an invalid channel as usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-cli-env-'))
    roots.push(root)
    ConfigIdentityStore.loadOrCreate(root, 'development')

    const config = AppConfig.load(CliArguments.parse(['status']), {
      JAMAT_V3_CONFIG_DIR: root,
      JAMAT_V3_RUNTIME_CHANNEL: 'development',
      JAMAT_CONFIG_DIR: join(root, 'wrong'),
    })
    expect(config.configDir).toBe(root)

    expect(() => AppConfig.load(CliArguments.parse(['status']), {
      JAMAT_V3_CONFIG_DIR: root,
      JAMAT_V3_RUNTIME_CHANNEL: 'preview',
    })).toThrow(AppClientCliError)
  })

  it('keeps the config env strict and refuses identity selection beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-cli-env-strict-'))
    roots.push(root)
    const missing = join(root, 'missing')

    expect(() => AppConfig.load(CliArguments.parse(['status']), {
      JAMAT_V3_CONFIG_DIR: missing,
    })).toThrow(/No AppClientUI config identity/)
    expect(() => AppConfig.load(CliArguments.parse([
      'status', '--config-identity', 'identity-a',
    ]), {
      JAMAT_V3_CONFIG_DIR: root,
    })).toThrow(/cannot be combined/)
  })
})
