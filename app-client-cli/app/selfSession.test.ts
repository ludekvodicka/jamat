import { describe, expect, it } from 'vitest'
import { AppConfig } from './appConfig'
import { CliArguments } from './cliArguments'
import { SelfSession } from './selfSession'

describe('app-client-cli/app/selfSession', () => {
  it('uses the full controller pair, discovers with only an id, and returns null without an id', () => {
    const env = { JAMAT_V3_SESSION_ID: 'session', JAMAT_V3_SESSION_CONTROLLER: 'controller', JAMAT_V3_SESSION_CHANNEL: 'production' }
    expect(SelfSession.of(env)).toEqual({ sessionId: 'session', controller: { configIdentity: 'controller', channel: 'production' } })
    expect(SelfSession.of({ JAMAT_V3_SESSION_ID: 'session' })).toEqual({ sessionId: 'session', controller: null })
    expect(SelfSession.of({})).toBeNull()
    expect(() => SelfSession.of({ ...env, JAMAT_V3_SESSION_CHANNEL: 'wrong' })).toThrow('SESSION_CHANNEL')
  })

  it('isolates self controller selection from inherited application startup variables', () => {
    const args = CliArguments.parse(['commit-svn-jamat', '--self'])
    const config = AppConfig.load(args, { JAMAT_V3_SESSION_ID: 'session', JAMAT_V3_SESSION_CONTROLLER: 'controller', JAMAT_V3_SESSION_CHANNEL: 'production',
      JAMAT_V3_CONFIG_DIR: 'Q:/wrong', JAMAT_V3_RUNTIME_CHANNEL: 'development' })
    expect(config.configDir).toBeNull()
    expect(config.configIdentity).toBe('controller')
    expect(config.runtimeChannel).toBe('production')
    expect(AppConfig.load(args, { JAMAT_V3_CONFIG_DIR: 'Q:/wrong', JAMAT_V3_RUNTIME_CHANNEL: 'production', JAMAT_V3_SESSION_ID: 'session' }))
      .toMatchObject({ configDir: null, configIdentity: null, runtimeChannel: null })
  })
})
