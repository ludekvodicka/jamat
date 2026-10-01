import { isIPv4 } from 'node:net'
import { isAbsolute } from 'node:path'

import { ConfigIdentityStore } from '../shared/configIdentityStore'
import type { RuntimeChannel } from '../shared/configIdentity.types'

export type RemoteLauncherRecipe =
  | { kind: 'executable'; path: string }
  | { kind: 'source'; repositoryRoot: string }
  | { kind: 'command'; command: string; args: string[]; cwd: string; windowsVerbatimArguments: boolean }

export interface RemoteLauncherConfigData {
  publicUrl: string
  key: string
  configDir: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
  recipe: RemoteLauncherRecipe
  logFile: string
}

export class RemoteLauncherConfig {
  static parse(value: unknown): RemoteLauncherConfigData {
    if (!RemoteLauncherConfig.record(value)
      || !RemoteLauncherConfig.keys(value, ['publicUrl', 'key', 'configDir', 'configIdentity', 'runtimeChannel', 'recipe', 'logFile']))
      throw new Error('Invalid launcher config fields')
    const publicUrl = RemoteLauncherConfig.origin(value.publicUrl)
    if (typeof value.key !== 'string' || !/^[a-f0-9]{64}$/i.test(value.key)
      || typeof value.configIdentity !== 'string' || !value.configIdentity
      || !ConfigIdentityStore.isRuntimeChannel(value.runtimeChannel))
      throw new Error('Invalid launcher key or profile')
    const recipe = value.recipe
    let parsedRecipe: RemoteLauncherRecipe
    if (!RemoteLauncherConfig.record(recipe)) throw new Error('Invalid launch recipe')
    if (recipe.kind === 'executable' && RemoteLauncherConfig.keys(recipe, ['kind', 'path']))
      parsedRecipe = { kind: 'executable', path: RemoteLauncherConfig.path(recipe.path) }
    else if (recipe.kind === 'source' && RemoteLauncherConfig.keys(recipe, ['kind', 'repositoryRoot']))
      parsedRecipe = { kind: 'source', repositoryRoot: RemoteLauncherConfig.path(recipe.repositoryRoot) }
    else if (recipe.kind === 'command'
      && RemoteLauncherConfig.keys(recipe, ['kind', 'command', 'args', 'cwd', 'windowsVerbatimArguments'])
      && typeof recipe.windowsVerbatimArguments === 'boolean'
      && Array.isArray(recipe.args) && recipe.args.every(arg => typeof arg === 'string' && !arg.includes('\0')))
      parsedRecipe = { kind: 'command', command: RemoteLauncherConfig.path(recipe.command),
        args: [...recipe.args], cwd: RemoteLauncherConfig.path(recipe.cwd),
        windowsVerbatimArguments: recipe.windowsVerbatimArguments }
    else throw new Error('Invalid launch recipe')
    return { publicUrl, key: value.key, configIdentity: value.configIdentity,
      runtimeChannel: value.runtimeChannel, configDir: RemoteLauncherConfig.path(value.configDir),
      recipe: parsedRecipe, logFile: RemoteLauncherConfig.path(value.logFile) }
  }

  static origin(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Launcher address must be an HTTP IPv4 origin')
    let url: URL
    try { url = new URL(value) }
    catch { throw new Error('Launcher address must be an HTTP IPv4 origin') }
    if (url.protocol !== 'http:' || !isIPv4(url.hostname) || url.pathname !== '/'
      || url.search || url.hash || url.username || url.password)
      throw new Error('Launcher address must be an HTTP IPv4 origin')
    return url.origin
  }

  private static path(value: unknown): string {
    if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value))
      throw new Error('Launcher paths must be absolute')
    return value
  }

  private static record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private static keys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  }
}
