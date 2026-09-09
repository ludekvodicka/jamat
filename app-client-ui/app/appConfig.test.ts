import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AppConfig } from './appConfig'

describe('app-client-ui/app/appConfig', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryConfigDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-config-'))
    created.push(directory)
    return directory
  }

  function restoreEnv(key: string, saved: string | undefined): void {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }

  /** Relative to the package root, so `resolve` has a cwd to prove it against. */
  function relativeConfigDir(): string {
    const relativePath = join('out', `test-config-${randomUUID()}`)
    created.push(resolve(relativePath))
    return relativePath
  }

  it('defaults an unpackaged launch to the development channel', () => {
    const config = AppConfig.load(false, ['--config-dir', temporaryConfigDir()], {})
    expect(config.runtimeChannel).toBe('development')
    expect(config.identity.runtimeChannel).toBe('development')
  })

  it('defaults a packaged launch to the production channel', () => {
    const config = AppConfig.load(true, ['--config-dir', temporaryConfigDir()], {})
    expect(config.runtimeChannel).toBe('production')
    expect(config.identity.runtimeChannel).toBe('production')
  })

  it('prefers an explicit --channel over the packaged default', () => {
    const config = AppConfig.load(
      true,
      ['--config-dir', temporaryConfigDir(), '--channel', 'development'],
      {},
    )
    expect(config.runtimeChannel).toBe('development')
  })

  it('prefers JAMAT_V3_RUNTIME_CHANNEL over the packaged default', () => {
    const config = AppConfig.load(
      true,
      ['--config-dir', temporaryConfigDir()],
      { JAMAT_V3_RUNTIME_CHANNEL: 'development' },
    )
    expect(config.runtimeChannel).toBe('development')
  })

  it('prefers the --channel argument over the environment variable', () => {
    const config = AppConfig.load(
      false,
      ['--config-dir', temporaryConfigDir(), '--channel', 'production'],
      { JAMAT_V3_RUNTIME_CHANNEL: 'development' },
    )
    expect(config.runtimeChannel).toBe('production')
  })

  it('rejects a channel value outside the two known channels', () => {
    expect(() => AppConfig.load(false, ['--config-dir', temporaryConfigDir(), '--channel', 'staging'], {}))
      .toThrow(/--channel must be production or development/)
  })

  it('resolves a relative --config-dir to an absolute path', () => {
    const relativePath = relativeConfigDir()
    const config = AppConfig.load(false, ['--config-dir', relativePath], {})
    expect(config.configDir).toBe(resolve(relativePath))
  })

  it('falls back to JAMAT_V3_CONFIG_DIR when no --config-dir is given', () => {
    const directory = temporaryConfigDir()
    const config = AppConfig.load(false, [], { JAMAT_V3_CONFIG_DIR: directory })
    expect(config.configDir).toBe(resolve(directory))
  })

  // A terminal opened inside V1 or V2 exports JAMAT_CONFIG_DIR, and everything started from there
  // inherits it. Reading that name pointed a V3 launch at another generation's config directory and
  // at its configIdentity; the channel guard only caught it because the identities differed.
  // The home directory is redirected for the duration: the fallback must be provable without
  // creating an identity document in the developer's real one.
  it('ignores JAMAT_CONFIG_DIR, which belongs to V1 and V2', () => {
    const foreign = temporaryConfigDir()
    const home = temporaryConfigDir()
    const savedProfile = process.env.USERPROFILE
    const savedHome = process.env.HOME
    process.env.USERPROFILE = home
    process.env.HOME = home
    try {
      const config = AppConfig.load(false, [], { JAMAT_CONFIG_DIR: foreign })
      expect(config.configDir).toBe(join(home, '.jamat-v3'))
    } finally {
      restoreEnv('USERPROFILE', savedProfile)
      restoreEnv('HOME', savedHome)
    }
  })

  it('lets --config-dir win over an inherited JAMAT_CONFIG_DIR', () => {
    const chosen = temporaryConfigDir()
    const foreign = temporaryConfigDir()
    const config = AppConfig.load(false, ['--config-dir', chosen], { JAMAT_CONFIG_DIR: foreign })
    expect(config.configDir).toBe(resolve(chosen))
  })
})
