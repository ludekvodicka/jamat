import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  ConfigIdentityDocument,
  RuntimeChannel,
} from '../../lib-orchestrator/shared/configIdentity.types'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'

export class AppConfig {
  /** Separate from V2's `.jamat` on purpose: one config directory belongs to one generation. */
  private static readonly defaultConfigDirNameConst = '.jamat-v3'

  private constructor(
    readonly configDir: string,
    readonly runtimeChannel: RuntimeChannel,
    readonly identity: ConfigIdentityDocument,
  ) {}

  /** `packaged` is a parameter, not `app.isPackaged`, so loading stays testable without Electron. */
  static load(
    packaged: boolean,
    argv: readonly string[] = process.argv,
    env: NodeJS.ProcessEnv = process.env,
  ): AppConfig {
    const explicitDir = AppConfig.argumentValue(argv, '--config-dir')
      ?? env.JAMAT_V3_CONFIG_DIR
      ?? null
    // The Host takes its channel from tooling that always passes one; this client is launched by a
    // person, so an unpackaged launch means development unless the launch says otherwise.
    const channel = AppConfig.argumentValue(argv, '--channel')
      ?? env.JAMAT_V3_RUNTIME_CHANNEL
      ?? (packaged ? 'production' : 'development')
    if (!ConfigIdentityStore.isRuntimeChannel(channel))
      throw new Error('--channel must be production or development')
    const configDir = AppConfig.resolveConfigDir(explicitDir)
    return new AppConfig(
      configDir,
      channel,
      ConfigIdentityStore.loadOrCreate(configDir, channel),
    )
  }

  private static resolveConfigDir(explicit: string | null): string {
    const trimmed = explicit?.trim()
    if (trimmed) return resolve(trimmed)
    return join(homedir(), AppConfig.defaultConfigDirNameConst)
  }

  private static argumentValue(argv: readonly string[], flag: string): string | null {
    const index = argv.indexOf(flag)
    return index >= 0 && index + 1 < argv.length
      ? argv[index + 1]
      : null
  }
}
