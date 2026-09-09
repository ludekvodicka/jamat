import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AppConfig } from './appConfig.js'

describe('app-host/app/appConfig', () => {
  const created: string[] = []
  const savedArgv = process.argv
  const savedEnv = { ...process.env }

  afterEach(() => {
    process.argv = savedArgv
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key]
    for (const [key, value] of Object.entries(savedEnv))
      if (process.env[key] !== value) process.env[key] = value
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryConfigDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-config-'))
    created.push(directory)
    return directory
  }

  function launch(argv: readonly string[], env: Record<string, string | undefined>): AppConfig {
    process.argv = ['node', 'start.ts', ...argv]
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    return AppConfig.load()
  }

  it('takes the config directory from --config-dir', () => {
    const directory = temporaryConfigDir()
    const config = launch(['--config-dir', directory, '--channel', 'development'], {
      JAMAT_V3_CONFIG_DIR: undefined,
      JAMAT_CONFIG_DIR: undefined,
    })
    expect(config.configDir).toBe(resolve(directory))
    expect(config.runtimeChannel).toBe('development')
  })

  it('falls back to JAMAT_V3_CONFIG_DIR when no --config-dir is given', () => {
    const directory = temporaryConfigDir()
    const config = launch(['--channel', 'development'], { JAMAT_V3_CONFIG_DIR: directory })
    expect(config.configDir).toBe(resolve(directory))
  })

  // A terminal opened inside V1 or V2 exports JAMAT_CONFIG_DIR, and everything started from there
  // inherits it. Reading that name pointed a Host at another generation's config directory, and the
  // Host is the process whose state outlives its clients, so it is the worse place to land wrong.
  it('ignores JAMAT_CONFIG_DIR, which belongs to V1 and V2', () => {
    const foreign = temporaryConfigDir()
    const home = temporaryConfigDir()
    const config = launch(['--channel', 'development'], {
      JAMAT_CONFIG_DIR: foreign,
      JAMAT_V3_CONFIG_DIR: undefined,
      USERPROFILE: home,
      HOME: home,
    })
    expect(config.configDir).toBe(join(homedir(), '.jamat-v3'))
    expect(config.configDir).not.toBe(resolve(foreign))
  })

  it('reads the channel from JAMAT_V3_RUNTIME_CHANNEL and refuses anything else', () => {
    const directory = temporaryConfigDir()
    const config = launch(['--config-dir', directory], { JAMAT_V3_RUNTIME_CHANNEL: 'production' })
    expect(config.runtimeChannel).toBe('production')
    expect(() => launch(['--config-dir', temporaryConfigDir()], {
      JAMAT_V3_RUNTIME_CHANNEL: 'staging',
    })).to.throw('--channel must be production or development')
  })
})
