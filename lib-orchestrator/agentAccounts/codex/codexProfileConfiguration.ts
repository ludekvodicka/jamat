import { CodexAppServerClient } from '../../rateMonitor/codexAppServerView'
import { JsonShape } from '../../shared/jsonShape'
import { PathCompare } from '../../shared/pathCompare'
import { AccountProblem } from '../accountProblem'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AccountLaunchSettings, RetainProfile } from '../agentAccountsApi.types'
import { CodexLaunchConfiguration } from './codexLaunchConfiguration'

export class CodexProfileConfiguration {
  private readonly environment: NodeJS.ProcessEnv

  constructor(environment: NodeJS.ProcessEnv) { this.environment = environment }

  async verify(home: string, mainHome: string, cwd: string, settings?: AccountLaunchSettings, retain?: RetainProfile): Promise<void> {
    const value = await this.inspect(home, mainHome, cwd, settings, retain)
    CodexProfileConfiguration.check(value, mainHome, this.environment.CODEX_SQLITE_HOME, cwd)
  }

  async identityStore(home: string, mainHome: string, retain?: RetainProfile): Promise<void> {
    await this.inspect(home, mainHome, home, undefined, retain)
  }

  private async inspect(home: string, mainHome: string, cwd: string, settings?: AccountLaunchSettings, retain?: RetainProfile): Promise<unknown> {
    const environment: NodeJS.ProcessEnv = { ...this.environment, CODEX_HOME: home, CODEX_SQLITE_HOME: mainHome }
    for (const name of ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_IDENTITY_TOKEN_FILE',
      'OPENAI_FEDERATION_RULE_ID', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT']) delete environment[name]
    const launch = CodexLaunchConfiguration.of(cwd, settings)
    const expectedLayer = { ...launch.layer, cli_auth_credentials_store: 'ephemeral' }
    const client = new CodexAppServerClient({ environment, homeDirectory: home,
      configOverrides: [...launch.overrides, 'cli_auth_credentials_store="ephemeral"'], onNotification: () => {} })
    try {
      const answer = await client.readConfiguration(cwd)
      if (!answer.ok) throw new AccountProblem('Codex effective configuration could not be verified')
      const requirements = await client.readConfigurationRequirements()
      const policy = requirements.ok ? JsonShape.record(requirements.result) : null
      if (!policy || !('requirements' in policy)) throw new AccountProblem('Codex configuration requirements could not be verified')
      const required = JsonShape.record(policy.requirements)
      if (policy.requirements !== null && !required) throw new AccountProblem('Codex configuration requirements could not be verified')
      if (required?.cliAuthCredentialsStore !== undefined && required.cliAuthCredentialsStore !== null)
        throw new AccountProblem('Managed Codex credential storage is not supported for account identity checks')
      if (required?.sqliteHome !== undefined && required.sqliteHome !== null)
        throw new AccountProblem('Managed Codex SQLite storage is not supported for added accounts')
      CodexProfileConfiguration.checkStore(answer.result, expectedLayer)
      return answer.result
    } finally {
      if (!await client.close()) {
        retain?.(client.waitForExit())
        throw new AccountProblem('Codex configuration reader did not stop')
      }
    }
  }

  static checkStore(value: unknown, expectedLayer: Record<string, unknown> = { cli_auth_credentials_store: 'ephemeral' }): void {
    const result = JsonShape.record(value), config = JsonShape.record(result?.config)
    if (!config || config.cli_auth_credentials_store !== 'ephemeral' || !Array.isArray(result?.layers))
      throw new AccountProblem('Codex credential storage could not be verified')
    let removed = false
    let selected: unknown = undefined
    for (const [index, raw] of result.layers.entries()) {
      const layer = JsonShape.record(raw), name = JsonShape.record(layer?.name), data = JsonShape.record(layer?.config)
      if (!layer || !name || !data || typeof layer.version !== 'string'
        || (layer.disabledReason !== undefined && layer.disabledReason !== null && typeof layer.disabledReason !== 'string'))
        throw new AccountProblem('Codex credential storage has an unsupported configuration layer')
      switch (name.type) {
        case 'sessionFlags':
          if (index !== 0 || removed || !isDeepStrictEqual(data, expectedLayer) || layer.disabledReason)
            throw new AccountProblem('Codex credential storage has unexpected inspection overrides')
          removed = true
          continue
        case 'packagedDefaults':
        case 'mdm':
        case 'system':
        case 'enterpriseManaged':
        case 'user':
        case 'project':
        case 'legacyManagedConfigTomlFromFile':
        case 'legacyManagedConfigTomlFromMdm': break
        default: throw new AccountProblem('Codex credential storage has an unsupported configuration layer')
      }
      if (!layer.disabledReason && selected === undefined && data.cli_auth_credentials_store !== undefined)
        selected = data.cli_auth_credentials_store
    }
    if (!removed) throw new AccountProblem('Codex credential storage inspection override is missing')
    // The installed release's native layers are ordered highest first; its default store is File.
    if (selected !== undefined && selected !== 'file')
      throw new AccountProblem('Codex accounts require file credential storage; keyring, auto and ephemeral storage are not supported')
  }

  static check(value: unknown, mainHome: string, inheritedSqliteHome?: string, cwd = mainHome): void {
    const result = JsonShape.record(value), config = JsonShape.record(result?.config)
    if (!config) throw new AccountProblem('Codex effective configuration could not be verified')
    const sqliteHome = config.sqlite_home
    if (sqliteHome === undefined || sqliteHome === null) {
      const inherited = inheritedSqliteHome?.trim()
      if (inherited && PathCompare.comparable(resolve(cwd, inherited)) !== PathCompare.comparable(mainHome))
        throw new AccountProblem('Main Codex CODEX_SQLITE_HOME must use the main profile home for added accounts')
      return
    }
    if (typeof sqliteHome !== 'string' || PathCompare.comparable(sqliteHome) !== PathCompare.comparable(mainHome))
      throw new AccountProblem('Codex sqlite_home must use the main profile home for added accounts')
  }
}
