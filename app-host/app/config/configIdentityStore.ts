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

import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import { isRuntimeChannel, type RuntimeChannel } from '../wire/hostWire.js'
import type { ConfigIdentityDocument } from './configIdentity.types.js'

/**
 * The JSON half of V2's config identity. The sqlite registry that bound an identity to a directory
 * stays in V2: it coordinated the orchestrator and clients, neither of which exists here, so porting
 * it would add a schema nothing reads.
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

  static readFrom(configDir: string): ConfigIdentityDocument {
    return ConfigIdentityStore.read(join(configDir, ConfigIdentityStore.identityFileConst))
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
      throw new Error(`Invalid config identity ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!parsed || typeof parsed !== 'object')
      throw new Error(`Invalid config identity ${file}: expected an object`)
    const identity = parsed as Partial<ConfigIdentityDocument>
    if (identity.schemaVersion !== 1)
      throw new Error(`Unsupported config identity schema: ${identity.schemaVersion}`)
    if (typeof identity.configIdentity !== 'string'
      || !ConfigIdentityStore.uuidPatternConst.test(identity.configIdentity))
      throw new Error(`Invalid config identity UUID in ${file}`)
    if (!isRuntimeChannel(identity.runtimeChannel))
      throw new Error(`Invalid runtime channel in ${file}`)
    if (typeof identity.createdAt !== 'string' || !Number.isFinite(Date.parse(identity.createdAt)))
      throw new Error(`Invalid identity creation time in ${file}`)
    return identity as ConfigIdentityDocument
  }
}
