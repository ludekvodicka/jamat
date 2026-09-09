import { ErrorText } from './errorText'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { AtomicJsonFile } from './atomicJsonFile'
import type { ConfigIdentityDocument, RuntimeChannel } from './configIdentity.types'

/**
 * Canonical home of the client's copy. The exclusive-create semantics are load-bearing: a client and
 * the Host share one config-identity.json in the same config directory, so a race for the first
 * creation must still leave exactly one readable document. The Host keeps its own copy because no
 * import may leave that package, not because the two do anything different.
 */
export class ConfigIdentityStore {
  private static readonly identityFileConst = 'config-identity.json'
  private static readonly uuidPatternConst =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  static loadOrCreate(
    configDir: string,
    requestedChannel: RuntimeChannel,
  ): ConfigIdentityDocument {
    AtomicJsonFile.ensureDirectory(configDir)
    const file = join(configDir, ConfigIdentityStore.identityFileConst)
    if (!existsSync(file))
      ConfigIdentityStore.createExclusive(file, requestedChannel)
    const identity = ConfigIdentityStore.read(file)
    if (identity.runtimeChannel !== requestedChannel)
      throw new Error(
        `Config channel mismatch: identity is ${identity.runtimeChannel}, launch requested ${requestedChannel}`,
      )
    return identity
  }

  /**
   * The same identity, for a reader that must not invent one.
   *
   * `loadOrCreate` belongs to whoever OWNS a config directory - the apps that keep state there. A
   * short-lived client asking "which AppClientUI is this" has to be able to hear "none": creating
   * the file instead answers its own question with an identity nobody publishes under, and turns a
   * mistyped `--config-dir` into a silent "nothing is running".
   */
  static loadExisting(
    configDir: string,
    requestedChannel: RuntimeChannel,
  ): ConfigIdentityDocument | null {
    const file = join(configDir, ConfigIdentityStore.identityFileConst)
    if (!existsSync(file)) return null
    const identity = ConfigIdentityStore.read(file)
    if (identity.runtimeChannel !== requestedChannel)
      throw new Error(
        `Config channel mismatch: identity is ${identity.runtimeChannel}, launch requested ${requestedChannel}`,
      )
    return identity
  }

  /** Reads the stored channel as authority, for a strict config directory without a channel flag. */
  static readExisting(configDir: string): ConfigIdentityDocument | null {
    const file = join(configDir, ConfigIdentityStore.identityFileConst)
    return existsSync(file) ? ConfigIdentityStore.read(file) : null
  }

  static isRuntimeChannel(value: unknown): value is RuntimeChannel {
    return value === 'production' || value === 'development'
  }

  private static createExclusive(file: string, channel: RuntimeChannel): void {
    const identity: ConfigIdentityDocument = {
      schemaVersion: 1,
      configIdentity: randomUUID(),
      runtimeChannel: channel,
      createdAt: new Date().toISOString(),
    }
    const staging = `${file}.${process.pid}-${randomUUID()}.tmp`
    const descriptor = openSync(staging, 'wx', 0o600)
    try { writeFileSync(descriptor, JSON.stringify(identity, null, 2), 'utf8') }
    finally { closeSync(descriptor) }
    // Publishing a finished document under a link keeps both halves of the contract: a racing loser
    // gets EEXIST instead of reading a claimed-but-still-empty file, and no winner is ever replaced.
    try { linkSync(staging, file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && !existsSync(file))
        renameSync(staging, file)
    }
    finally { try { unlinkSync(staging) } catch {} }
  }

  private static read(file: string): ConfigIdentityDocument {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) }
    catch (error) {
      throw new Error(`Invalid config identity ${file}: ${ErrorText.of(error)}`)
    }
    if (!parsed || typeof parsed !== 'object')
      throw new Error(`Invalid config identity ${file}: expected an object`)
    const identity = parsed as Partial<ConfigIdentityDocument>
    if (identity.schemaVersion !== 1)
      throw new Error(`Unsupported config identity schema: ${identity.schemaVersion}`)
    if (typeof identity.configIdentity !== 'string'
      || !ConfigIdentityStore.uuidPatternConst.test(identity.configIdentity))
      throw new Error(`Invalid config identity UUID in ${file}`)
    if (!ConfigIdentityStore.isRuntimeChannel(identity.runtimeChannel))
      throw new Error(`Invalid runtime channel in ${file}`)
    if (typeof identity.createdAt !== 'string' || !Number.isFinite(Date.parse(identity.createdAt)))
      throw new Error(`Invalid identity creation time in ${file}`)
    return identity as ConfigIdentityDocument
  }
}
