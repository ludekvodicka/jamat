import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from '../../rateMonitor/codexAppServerView'
import { codexProfileEnvironment, codexShareTable } from './codexProfile'
import { CodexProfileConfiguration } from './codexProfileConfiguration'
import { CodexLaunchConfiguration } from './codexLaunchConfiguration'

afterEach(() => vi.restoreAllMocks())

describe('Codex profile layout', () => {
  it('shares the exact allow-list without identity, daemon state or SQLite files', () => {
    expect(codexShareTable.directories).toEqual(['sessions', 'skills', 'hooks', 'rules', 'plugins', 'memories', 'generated', 'vendor_imports', 'rollout-migrations'])
    expect(codexShareTable.files).toEqual(['config.toml', 'AGENTS.md', 'hooks.json', 'history.jsonl', 'session_index.jsonl'])
    const shared = [...codexShareTable.directories, ...codexShareTable.files]
    for (const entry of codexShareTable.neverShared) expect(shared).not.toContain(entry)
    expect(shared.some(entry => /sqlite|auth\.json|app-server-(control|daemon)/.test(entry))).toBe(false)
    expect(codexProfileEnvironment('C:/fixture/main')).toEqual({ CODEX_SQLITE_HOME: 'C:/fixture/main' })
  })

  it('accepts absent overrides or the main home and rejects effective conflicting storage', () => {
    const main = 'C:/fixture/main'
    for (const sqlite_home of [undefined, null, main])
      expect(() => CodexProfileConfiguration.check({ config: { sqlite_home } }, main)).not.toThrow()
    for (const sqlite_home of ['C:/fixture/project-state', 42, 'C:/fixture/added/sqlite-relative'])
      expect(() => CodexProfileConfiguration.check({ config: { sqlite_home } }, main)).toThrow('sqlite_home must use the main profile home')
    expect(() => CodexProfileConfiguration.check({}, main)).toThrow('could not be verified')
  })

  it('refuses an inherited main SQLite override that would split storage, including relative paths', () => {
    const config = { config: { sqlite_home: null } }, main = 'C:/fixture/main'
    expect(() => CodexProfileConfiguration.check(config, main, 'C:/fixture/other', 'C:/fixture/work')).toThrow('Main Codex CODEX_SQLITE_HOME')
    expect(() => CodexProfileConfiguration.check(config, main, '../other', 'C:/fixture/work')).toThrow('Main Codex CODEX_SQLITE_HOME')
    expect(() => CodexProfileConfiguration.check(config, main, '../main', 'C:/fixture/work')).not.toThrow()
    expect(() => CodexProfileConfiguration.check(config, main, '  ../main  ', 'C:/fixture/work')).not.toThrow()
    expect(() => CodexProfileConfiguration.check(config, main, '  ', 'C:/fixture/work')).not.toThrow()
    expect(() => CodexProfileConfiguration.check({ config: { sqlite_home: main } }, main, 'C:/fixture/other')).not.toThrow()
  })

  it('checks native credential layers below only the exact inspector override', () => {
    const layer = (type: string, store?: string, disabledReason?: string) => ({ name: { type }, version: 'fixture',
      config: store === undefined ? {} : { cli_auth_credentials_store: store }, disabledReason })
    const result = (layers: unknown[]) => ({ config: { cli_auth_credentials_store: 'ephemeral' }, layers })
    const inspector = layer('sessionFlags', 'ephemeral')
    expect(() => CodexProfileConfiguration.checkStore(result([inspector, layer('user')]))).not.toThrow()
    expect(() => CodexProfileConfiguration.checkStore(result([inspector, layer('project', 'file'), layer('user', 'auto')]))).not.toThrow()
    expect(() => CodexProfileConfiguration.checkStore(result([inspector, layer('project', 'auto', 'untrusted'), layer('user', 'file')]))).not.toThrow()
    for (const store of ['keyring', 'auto', 'ephemeral', 'future-store'])
      expect(() => CodexProfileConfiguration.checkStore(result([inspector, layer('user', store)]))).toThrow('require file credential storage')
    for (const layers of [[], [layer('user', 'file')], [inspector, inspector], [inspector, layer('future-layer', 'file')],
      [layer('user', 'file'), inspector], [{ ...inspector, config: { cli_auth_credentials_store: 'ephemeral', other: true } }]])
      expect(() => CodexProfileConfiguration.checkStore(result(layers))).toThrow()
  })

  it('passes the launch directory to native config inspection and closes the child on every refusal', async () => {
    const read = vi.spyOn(CodexAppServerClient.prototype, 'readConfiguration').mockResolvedValue({ ok: true, result: {
      config: { cli_auth_credentials_store: 'ephemeral' }, layers: [
        { name: { type: 'sessionFlags' }, version: 'fixture', config: { cli_auth_credentials_store: 'ephemeral' } },
      ],
    } })
    const requirements = vi.spyOn(CodexAppServerClient.prototype, 'readConfigurationRequirements')
      .mockResolvedValue({ ok: true, result: { requirements: null } })
    const close = vi.spyOn(CodexAppServerClient.prototype, 'close').mockResolvedValue(true)
    const configuration = new CodexProfileConfiguration({})
    await configuration.verify('C:/added', 'C:/main', 'C:/workspace')
    expect(read).toHaveBeenCalledExactlyOnceWith('C:/workspace')
    for (const [key, reason] of [['cliAuthCredentialsStore', 'Managed Codex credential'], ['sqliteHome', 'Managed Codex SQLite']]) {
      requirements.mockResolvedValueOnce({ ok: true, result: { requirements: { [key!]: 'enforced' } } })
      await expect(configuration.verify('C:/added', 'C:/main', 'C:/workspace')).rejects.toThrow(reason)
    }
    read.mockResolvedValueOnce({ ok: false, code: 'failed', reason: 'SENSITIVE_NATIVE_OUTPUT' })
    await expect(configuration.verify('C:/added', 'C:/main', 'C:/workspace')).rejects.toThrow('Codex effective configuration could not be verified')
    expect(close).toHaveBeenCalledTimes(4)
    close.mockResolvedValueOnce(false)
    await expect(configuration.verify('C:/added', 'C:/main', 'C:/workspace')).rejects.toThrow('Codex configuration reader did not stop')
  })

  it('validates the entire actual launch override layer before checking newly trusted project storage', async () => {
    const launch = CodexLaunchConfiguration.of('C:/workspace', { yolo: true, model: 'fixture', effort: 'low' })
    expect(launch).toEqual({ overrides: ['model="fixture"', 'model_reasoning_effort="low"', 'approval_policy="never"',
      'sandbox_mode="danger-full-access"', 'projects={"C:/workspace"={trust_level="trusted"}}'], layer: {
      model: 'fixture', model_reasoning_effort: 'low', approval_policy: 'never', sandbox_mode: 'danger-full-access',
      projects: { 'C:/workspace': { trust_level: 'trusted' } },
    } })
    const expected = { ...launch.layer, cli_auth_credentials_store: 'ephemeral' }
    const result = { config: { cli_auth_credentials_store: 'ephemeral', sqlite_home: 'C:/conflicting-project' },
      layers: [{ name: { type: 'sessionFlags' }, version: 'fixture', config: expected }] }
    expect(() => CodexProfileConfiguration.checkStore(result, expected)).not.toThrow()
    expect(() => CodexProfileConfiguration.checkStore(result)).toThrow('unexpected inspection overrides')
    expect(() => CodexProfileConfiguration.checkStore({ ...result, layers: [
      { ...result.layers[0], config: { ...expected, unexpected: true } },
    ] }, expected)).toThrow('unexpected inspection overrides')
    vi.spyOn(CodexAppServerClient.prototype, 'readConfiguration').mockResolvedValue({ ok: true, result })
    vi.spyOn(CodexAppServerClient.prototype, 'readConfigurationRequirements').mockResolvedValue({ ok: true, result: { requirements: null } })
    vi.spyOn(CodexAppServerClient.prototype, 'close').mockResolvedValue(true)
    await expect(new CodexProfileConfiguration({}).verify('C:/added', 'C:/main', 'C:/workspace',
      { yolo: true, model: 'fixture', effort: 'low' })).rejects.toThrow('sqlite_home must use the main profile home')
  })
})
