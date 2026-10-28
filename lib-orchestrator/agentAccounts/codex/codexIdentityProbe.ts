import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandInvoker } from '../../shared/commandInvoker'
import { ChildEnvironment } from '../../shared/childEnvironment'
import { ErrnoCode } from '../../shared/errnoCode'
import { JsonShape } from '../../shared/jsonShape'
import type { IdentityProbe } from '../profiles/profileShareTable'
import { CodexProfileConfiguration } from './codexProfileConfiguration'
import { AccountProblem } from '../accountProblem'
import type { RetainProfile } from '../agentAccountsApi.types'

export class CodexIdentityProbe {
  private readonly environment: NodeJS.ProcessEnv
  private readonly command: Pick<CommandInvoker, 'run'>
  private readonly configuration: Pick<CodexProfileConfiguration, 'identityStore'>

  constructor(environment: NodeJS.ProcessEnv, command: Pick<CommandInvoker, 'run'> = new CommandInvoker(),
    configuration: Pick<CodexProfileConfiguration, 'identityStore'> = new CodexProfileConfiguration(environment)) {
    this.environment = environment
    this.command = command
    this.configuration = configuration
  }

  async read(home: string, mainHome: string, retain?: RetainProfile): Promise<IdentityProbe> {
    if (['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_FEDERATION_RULE_ID']
      .some(name => Object.hasOwn(this.environment, name)))
      return { kind: 'failed', reason: 'Codex environment authentication is not supported for account identity checks' }
    let identity: IdentityProbe
    try {
      const file = join(home, 'auth.json'), info = lstatSync(file)
      if (!info.isFile() || info.size > 1_048_576)
        return { kind: 'failed', reason: 'Codex identity metadata must be a regular file smaller than 1 MiB' }
      identity = CodexIdentityProbe.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return { kind: 'logged-out' }
      return { kind: 'failed', reason: 'Codex identity metadata could not be read' }
    }
    if (identity.kind !== 'logged-in') return identity
    try { await this.configuration.identityStore(home, mainHome, retain) }
    catch (error) {
      return { kind: 'failed', reason: error instanceof AccountProblem ? error.message : 'Codex credential storage could not be verified' }
    }
    const args = ['-c', 'cli_auth_credentials_store="file"', 'login', 'status']
    const result = await this.command.run({ command: process.platform === 'win32' ? this.environment.ComSpec ?? 'cmd.exe' : 'codex',
      args: process.platform === 'win32' ? ['/d', '/q', '/c', 'codex', ...args] : args,
      cwd: home, env: { ...ChildEnvironment.withoutJamat(this.environment), CODEX_HOME: home, CODEX_SQLITE_HOME: mainHome },
      timeoutMs: 10_000, retain: { tailBytes: 0 }, onLifetime: retain })
    if (result.failure !== null) return { kind: 'failed', reason: 'Codex login status could not be checked' }
    if (result.code !== 0) return { kind: 'logged-out' }
    return identity
  }

  static parse(text: string): IdentityProbe {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return { kind: 'failed', reason: 'Codex identity metadata is not JSON' } }
    const root = JsonShape.record(raw), metadata = JsonShape.record(root?.tokens)
    if (!root) return { kind: 'failed', reason: 'Invalid Codex identity metadata' }
    if (root.auth_mode !== undefined && root.auth_mode !== null && root.auth_mode !== 'chatgpt') return { kind: 'logged-out' }
    const accountId = metadata?.account_id
    if (typeof accountId === 'string' && accountId.trim())
      return { kind: 'logged-in', identity: { key: accountId, label: accountId } }
    return { kind: 'logged-out' }
  }
}
