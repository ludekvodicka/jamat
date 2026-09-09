import { describe, expect, it } from 'vitest'

import { ChildEnvironment } from './childEnvironment'

/**
 * The fixture is not invented: it is what was measured in a Claude Code session started from a
 * development Jamat on 2026-08-31, cut down to one member per group. The values matter as little as
 * the fixture's realism matters a lot - what is asserted is which NAMES survive.
 */
describe('lib-orchestrator/shared/childEnvironment', () => {
  const environmentConst: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    SHELL: '/bin/zsh',
    PNPM_HOME: 'C:\\pnpm',
    CLAUDE_CONFIG_DIR: 'Q:\\claude',
    CODEX_HOME: 'Q:\\codex',
    NODE_ENV: 'development',
    NODE_ENV_ELECTRON_VITE: 'development',
    NODE_PATH: 'Q:\\...\\electron-vite\\node_modules',
    INIT_CWD: 'C:\\Projects\\NodeJs\\AppJamatV3',
    PNPM_SCRIPT_SRC_DIR: 'C:\\Projects\\NodeJs\\AppJamatV3\\app-client-ui',
    PNPM_PACKAGE_NAME: 'jamat-v3-client-ui',
    ELECTRON_RENDERER_URL: 'http://localhost:5173',
    npm_package_name: 'jamat-v3-client-ui',
    npm_config_user_agent: 'pnpm/11.15.1 npm/? node/v24.18.0 win32 x64',
    pnpm_config_verify_deps_before_run: 'false',
    JAMAT_V3_CONFIG_DIR: 'Q:\\v3',
    JAMAT_CONFIG_DIR: 'Q:\\v1',
    JAMATANYTHING: 'x',
  }

  it('drops every variable the dev runtime wrote, whichever method is used', () => {
    for (const env of [
      ChildEnvironment.withoutJamat(environmentConst),
      ChildEnvironment.keepingJamat(environmentConst),
    ]) {
      expect(env.NODE_ENV).toBeUndefined()
      expect(env.NODE_ENV_ELECTRON_VITE).toBeUndefined()
      expect(env.NODE_PATH).toBeUndefined()
      expect(env.INIT_CWD).toBeUndefined()
      expect(env.PNPM_SCRIPT_SRC_DIR).toBeUndefined()
      expect(env.PNPM_PACKAGE_NAME).toBeUndefined()
      expect(env.ELECTRON_RENDERER_URL).toBeUndefined()
      expect(env.npm_package_name).toBeUndefined()
      expect(env.npm_config_user_agent).toBeUndefined()
      expect(env.pnpm_config_verify_deps_before_run).toBeUndefined()
    }
  })

  // pnpm writes them lower case today. A Windows environment does not promise the case it hands
  // back, and a match that only knew one of the two would let the whole group through.
  it('matches the prefixes whatever case they arrive in', () => {
    const env = ChildEnvironment.withoutJamat({
      NPM_CONFIG_USER_AGENT: 'pnpm',
      Npm_Config_Registry: 'https://registry.example',
      electron_renderer_url: 'http://localhost:5173',
      node_path: 'Q:\\wrong\\tree',
    })
    expect(Object.keys(env)).toEqual([])
  })

  it('keeps PNPM_HOME while dropping the pnpm script variables around it', () => {
    const env = ChildEnvironment.withoutJamat(environmentConst)
    expect(env.PNPM_HOME).toBe('C:\\pnpm')
    expect(env.INIT_CWD).toBeUndefined()
    expect(env.PNPM_SCRIPT_SRC_DIR).toBeUndefined()
  })

  it('leaves the user environment alone', () => {
    const env = ChildEnvironment.withoutJamat(environmentConst)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(env.SHELL).toBe('/bin/zsh')
    expect(env.CLAUDE_CONFIG_DIR).toBe('Q:\\claude')
    expect(env.CODEX_HOME).toBe('Q:\\codex')
  })

  it('drops private RMCLI integration values from every child, whatever their key case', () => {
    const environment: NodeJS.ProcessEnv = {
      ...environmentConst,
      RMCLI_HOST: 'synthetic-host',
      RMCLI_FINGERPRINT: 'synthetic-fingerprint',
      RMCLI_PASSWORD_COMMAND: 'synthetic-command',
      rmcli_timeout_ms: '1000',
      RMCLI: 'near-miss',
      RMCLIENT_PASSWORD_COMMAND: 'near-miss',
    }
    for (const env of [
      ChildEnvironment.withoutJamat(environment),
      ChildEnvironment.keepingJamat(environment),
    ]) {
      expect(Object.keys(env).filter((key) => key.toUpperCase().startsWith('RMCLI_'))).toEqual([])
      expect(env.RMCLI).toBe('near-miss')
      expect(env.RMCLIENT_PASSWORD_COMMAND).toBe('near-miss')
    }
  })

  it('drops every Jamat variable for a stranger and keeps every one for the Host', () => {
    const stranger = ChildEnvironment.withoutJamat(environmentConst)
    expect(Object.keys(stranger).filter((key) => key.startsWith('JAMAT'))).toEqual([])

    const host = ChildEnvironment.keepingJamat(environmentConst)
    expect(host.JAMAT_V3_CONFIG_DIR).toBe('Q:\\v3')
    expect(host.JAMAT_CONFIG_DIR).toBe('Q:\\v1')
    expect(host.JAMATANYTHING).toBe('x')
  })

  it('drops a key that has no string value, so the result carries no undefined', () => {
    const env = ChildEnvironment.withoutJamat({ PATH: '/usr/bin', EMPTY: undefined })
    expect(Object.keys(env)).toEqual(['PATH'])
  })

  it('answers an empty environment with an empty object', () => {
    expect(ChildEnvironment.withoutJamat({})).toEqual({})
    expect(ChildEnvironment.keepingJamat({})).toEqual({})
  })
})
