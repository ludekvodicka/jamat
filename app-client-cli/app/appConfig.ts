import { resolve } from 'node:path'

import type {
  ConfigIdentityDocument,
  RuntimeChannel,
} from '../../lib-orchestrator/shared/configIdentity.types'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'
import { AppClientCliError } from './appClientCliError'
import type { CliArguments } from './cliArguments'

export class AppConfig {
  private constructor(
    readonly configDir: string | null,
    readonly runtimeChannel: RuntimeChannel | null,
    readonly identity: ConfigIdentityDocument | null,
    readonly configIdentity: string | null,
  ) {}

  static load(args: CliArguments, env: NodeJS.ProcessEnv = process.env): AppConfig {
    const channel = args.option('--channel')
      ?? env.JAMAT_V3_RUNTIME_CHANNEL
      ?? null
    if (channel !== null && !ConfigIdentityStore.isRuntimeChannel(channel))
      throw new AppClientCliError(
        'invalid-request',
        '--channel must be development or production',
      )
    const configIdentity = args.option('--config-identity')?.trim() ?? null
    const explicitDir = args.option('--config-dir') ?? env.JAMAT_V3_CONFIG_DIR ?? null
    if (configIdentity !== null && explicitDir !== null)
      throw new AppClientCliError(
        'invalid-request',
        '--config-identity cannot be combined with a config directory',
      )
    if (configIdentity === '')
      throw new AppClientCliError('invalid-request', '--config-identity cannot be empty')
    if (explicitDir === null)
      return new AppConfig(null, channel, null, configIdentity)
    if (!explicitDir.trim())
      throw new AppClientCliError('invalid-request', '--config-dir cannot be empty')
    const configDir = resolve(explicitDir)
    let identity: ConfigIdentityDocument | null
    try {
      identity = channel === null
        ? ConfigIdentityStore.readExisting(configDir)
        : ConfigIdentityStore.loadExisting(configDir, channel)
    }
    catch (error) {
      throw new AppClientCliError(
        'operation-failed',
        error instanceof Error ? error.message : String(error),
      )
    }
    /*
     * Read, never created. This CLI owns no durable state, and the identity is how it finds the
     * AppClientUI that published a descriptor - so an absent one is an answer, not a thing to make
     * up. Creating it silently turned a mistyped `--config-dir` into "nothing is running here".
     */
    if (identity === null)
      throw new AppClientCliError(
        'unavailable',
        `No AppClientUI config identity in ${configDir}; start AppClientUI with that config directory first`,
      )
    return new AppConfig(
      configDir,
      identity.runtimeChannel,
      identity,
      identity.configIdentity,
    )
  }
}
