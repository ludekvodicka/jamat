import { ConfigDir } from './config/configDir.js'
import type { ConfigIdentityDocument } from './config/configIdentity.types.js'
import { ConfigIdentityStore } from './config/configIdentityStore.js'
import { isRuntimeChannel, type RuntimeChannel } from './wire/hostWire.js'

export class AppConfig {
  private constructor(
    readonly configDir: string,
    readonly runtimeChannel: RuntimeChannel,
    readonly identity: ConfigIdentityDocument,
  ) {}

  static load(): AppConfig {
    const explicit = AppConfig.argumentValue('--config-dir')
      ?? process.env.JAMAT_V3_CONFIG_DIR
      ?? null
    const channelValue = AppConfig.argumentValue('--channel')
      ?? process.env.JAMAT_V3_RUNTIME_CHANNEL
    if (!isRuntimeChannel(channelValue))
      throw new Error('--channel must be production or development')
    const configDir = ConfigDir.resolve(explicit)
    return new AppConfig(
      configDir,
      channelValue,
      ConfigIdentityStore.loadOrCreate(configDir, channelValue),
    )
  }

  private static argumentValue(flag: string): string | null {
    const index = process.argv.indexOf(flag)
    return index >= 0 && index + 1 < process.argv.length
      ? process.argv[index + 1]
      : null
  }
}
