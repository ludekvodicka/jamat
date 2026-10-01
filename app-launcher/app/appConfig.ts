import { readFileSync } from 'node:fs'
import { RemoteLauncherConfig } from '../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import type { RemoteLauncherRecipe } from '../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'
import type { ConfigIdentityDocument } from '../../lib-orchestrator/shared/configIdentity.types'

export type LaunchRecipe = RemoteLauncherRecipe

export class AppConfig {
  readonly publicUrl: URL
  readonly key: Buffer
  readonly configDir: string
  readonly identity: ConfigIdentityDocument
  readonly recipe: LaunchRecipe
  readonly logFile: string

  constructor(source: string) {
    const value = RemoteLauncherConfig.parse(JSON.parse(source.replace(/^\uFEFF/, '')))
    this.publicUrl = new URL(value.publicUrl)
    this.key = Buffer.from(value.key, 'hex')
    this.configDir = value.configDir
    this.logFile = value.logFile
    const identity = ConfigIdentityStore.readExisting(this.configDir)
    if (!identity || identity.configIdentity !== value.configIdentity || identity.runtimeChannel !== value.runtimeChannel)
      throw new Error('Existing profile identity/channel does not match launcher config')
    this.identity = identity
    this.recipe = value.recipe
  }

  static read(path: string): AppConfig {
    return new AppConfig(readFileSync(path, 'utf8'))
  }
}
