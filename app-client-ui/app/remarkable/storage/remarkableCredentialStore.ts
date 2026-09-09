import { readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

import { AtomicJsonFile } from '../../../../lib-orchestrator/shared/atomicJsonFile'
import type { RuntimeChannel } from '../../../../lib-orchestrator/shared/configIdentity.types'
import { JsonShape } from '../../../../lib-orchestrator/shared/jsonShape'
import type {
  RemarkableErrorCode,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'
import { RemarkableSettings } from '../../../shared/remarkableSettings'

export interface RemarkableSecretCipher {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

interface RemarkableCredentialRecord {
  schemaVersion: 1
  configIdentity: string
  channel: RuntimeChannel
  host: string
  encryptedBase64: string
  updatedAt: string
}

interface RemarkableCredentialPayload {
  schemaVersion: 1
  configIdentity: string
  channel: RuntimeChannel
  host: string
  password: string
}

type RemarkableCredentialRead =
  | { kind: 'missing' }
  | { kind: 'damaged' }
  | { kind: 'ready'; record: RemarkableCredentialRecord; encrypted: Buffer }

export class RemarkableCredentialStore {
  private static readonly schemaVersionConst = 1
  private static readonly base64ShapeConst =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

  constructor(
    private readonly file: string,
    private readonly configIdentity: string,
    private readonly channel: RuntimeChannel,
    private readonly cipher: RemarkableSecretCipher,
  ) {
    if (!configIdentity) throw new Error('A config identity is required for reMarkable credentials')
  }

  configuredFor(host: string | undefined): boolean {
    if (!RemarkableSettings.isValidHost(host)) return false
    const reading = this.readRecord()
    if (reading.kind === 'missing' || reading.kind === 'damaged') return false
    else if (reading.kind === 'ready')
      return reading.record.configIdentity === this.configIdentity
        && reading.record.channel === this.channel
        && reading.record.host === host
    else throw new Error(`Unknown reMarkable credential reading: ${JSON.stringify(reading)}`)
  }

  async replace(host: string, password: string): Promise<RemarkableResult> {
    if (!RemarkableSettings.isValidHost(host))
      return RemarkableCredentialStore.failure(
        'settings-incomplete',
        'A valid reMarkable host is required before storing a password',
      )
    if (typeof password !== 'string' || password.length === 0)
      return RemarkableCredentialStore.failure(
        'password-missing',
        'The reMarkable password cannot be empty',
      )
    return await this.encryptAndWrite(host, password)
  }

  async clear(host: string): Promise<RemarkableResult> {
    if (!RemarkableSettings.isValidHost(host))
      return RemarkableCredentialStore.failure(
        'settings-incomplete',
        'A valid reMarkable host is required before clearing a password',
      )
    const reading = this.readRecord()
    if (reading.kind === 'ready'
      && (reading.record.configIdentity !== this.configIdentity
        || reading.record.channel !== this.channel
        || reading.record.host !== host)) return RemarkableCredentialStore.success()
    try {
      RemarkableCredentialStore.unlinkIfPresent(this.file)
      RemarkableCredentialStore.unlinkIfPresent(`${this.file}.tmp`)
      return RemarkableCredentialStore.success()
    } catch {
      return RemarkableCredentialStore.failure(
        'credential-unavailable',
        'The reMarkable credential could not be cleared',
      )
    }
  }

  /** Main-process only. Renderer-safe contracts expose `passwordConfigured`, never this value. */
  async passwordFor(host: string): Promise<RemarkableResult<string>> {
    if (!RemarkableSettings.isValidHost(host))
      return RemarkableCredentialStore.failure(
        'settings-incomplete',
        'A valid reMarkable host is required before reading a password',
      )

    const reading = this.readRecord()
    if (reading.kind === 'missing') return RemarkableCredentialStore.passwordMissing()
    else if (reading.kind === 'damaged') return RemarkableCredentialStore.credentialDamaged()
    else if (reading.kind !== 'ready')
      throw new Error(`Unknown reMarkable credential reading: ${JSON.stringify(reading)}`)
    if (reading.record.configIdentity !== this.configIdentity
      || reading.record.channel !== this.channel
      || reading.record.host !== host)
      return RemarkableCredentialStore.passwordMissing()

    if (!await this.encryptionAvailable())
      return RemarkableCredentialStore.failure(
        'credential-unavailable',
        'Secure credential storage is unavailable on this computer',
      )

    let decrypted: { result: string; shouldReEncrypt: boolean }
    try {
      decrypted = await this.cipher.decrypt(reading.encrypted)
    } catch {
      return RemarkableCredentialStore.credentialDamaged()
    }
    const payload = RemarkableCredentialStore.payloadOf(decrypted.result)
    if (payload === null
      || payload.configIdentity !== reading.record.configIdentity
      || payload.channel !== reading.record.channel
      || payload.host !== reading.record.host
      || typeof decrypted.shouldReEncrypt !== 'boolean')
      return RemarkableCredentialStore.credentialDamaged()

    if (decrypted.shouldReEncrypt) {
      const refreshed = await this.encryptAndWrite(host, payload.password)
      if (!refreshed.ok) return refreshed
    }
    return { ok: true, value: payload.password }
  }

  private async encryptAndWrite(host: string, password: string): Promise<RemarkableResult> {
    if (!await this.encryptionAvailable())
      return RemarkableCredentialStore.failure(
        'credential-unavailable',
        'Secure credential storage is unavailable on this computer',
      )

    let encrypted: Buffer
    try {
      encrypted = await this.cipher.encrypt(JSON.stringify({
        schemaVersion: RemarkableCredentialStore.schemaVersionConst,
        configIdentity: this.configIdentity,
        channel: this.channel,
        host,
        password,
      } satisfies RemarkableCredentialPayload))
    } catch {
      return RemarkableCredentialStore.failure(
        'credential-unavailable',
        'The reMarkable credential could not be encrypted',
      )
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0)
      return RemarkableCredentialStore.failure(
        'credential-unavailable',
        'The reMarkable credential cipher returned no data',
      )

    const record: RemarkableCredentialRecord = {
      schemaVersion: RemarkableCredentialStore.schemaVersionConst,
      configIdentity: this.configIdentity,
      channel: this.channel,
      host,
      encryptedBase64: encrypted.toString('base64'),
      updatedAt: new Date().toISOString(),
    }
    try {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      AtomicJsonFile.write(this.file, record)
      return RemarkableCredentialStore.success()
    } catch {
      return RemarkableCredentialStore.failure(
        'credential-unavailable',
        'The reMarkable credential could not be stored securely',
      )
    }
  }

  private async encryptionAvailable(): Promise<boolean> {
    try { return await this.cipher.available() }
    catch { return false }
  }

  private readRecord(): RemarkableCredentialRead {
    let value: unknown
    try { value = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch (error) {
      if (RemarkableCredentialStore.errorCode(error) === 'ENOENT') return { kind: 'missing' }
      return { kind: 'damaged' }
    }

    const document = JsonShape.record(value)
    if (document === null
      || document['schemaVersion'] !== RemarkableCredentialStore.schemaVersionConst
      || typeof document['configIdentity'] !== 'string'
      || document['configIdentity'].length === 0
      || !RemarkableCredentialStore.isRuntimeChannel(document['channel'])
      || !RemarkableSettings.isValidHost(document['host'])
      || typeof document['encryptedBase64'] !== 'string'
      || typeof document['updatedAt'] !== 'string'
      || !RemarkableCredentialStore.isIsoTimestamp(document['updatedAt']))
      return { kind: 'damaged' }
    const encrypted = RemarkableCredentialStore.decodeBase64(document['encryptedBase64'])
    if (encrypted === null) return { kind: 'damaged' }
    return {
      kind: 'ready',
      record: {
        schemaVersion: RemarkableCredentialStore.schemaVersionConst,
        configIdentity: document['configIdentity'],
        channel: document['channel'],
        host: document['host'],
        encryptedBase64: document['encryptedBase64'],
        updatedAt: document['updatedAt'],
      },
      encrypted,
    }
  }

  private static decodeBase64(value: string): Buffer | null {
    if (!value || !RemarkableCredentialStore.base64ShapeConst.test(value)) return null
    const result = Buffer.from(value, 'base64')
    return result.length > 0 && result.toString('base64') === value ? result : null
  }

  private static payloadOf(value: string): RemarkableCredentialPayload | null {
    let parsed: unknown
    try { parsed = JSON.parse(value) }
    catch { return null }
    const payload = JsonShape.record(parsed)
    if (payload === null
      || Object.keys(payload).sort().join(',') !== 'channel,configIdentity,host,password,schemaVersion'
      || payload['schemaVersion'] !== RemarkableCredentialStore.schemaVersionConst
      || typeof payload['configIdentity'] !== 'string'
      || payload['configIdentity'].length === 0
      || !RemarkableCredentialStore.isRuntimeChannel(payload['channel'])
      || !RemarkableSettings.isValidHost(payload['host'])
      || typeof payload['password'] !== 'string'
      || payload['password'].length === 0) return null
    return {
      schemaVersion: RemarkableCredentialStore.schemaVersionConst,
      configIdentity: payload['configIdentity'],
      channel: payload['channel'],
      host: payload['host'],
      password: payload['password'],
    }
  }

  private static isRuntimeChannel(value: unknown): value is RuntimeChannel {
    return value === 'development' || value === 'production'
  }

  private static isIsoTimestamp(value: string): boolean {
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value
  }

  private static unlinkIfPresent(file: string): void {
    try { unlinkSync(file) }
    catch (error) {
      if (RemarkableCredentialStore.errorCode(error) !== 'ENOENT') throw error
    }
  }

  private static errorCode(error: unknown): string | undefined {
    if (!JsonShape.isRecord(error)) return undefined
    return typeof error['code'] === 'string' ? error['code'] : undefined
  }

  private static success(): RemarkableResult {
    return { ok: true, value: undefined }
  }

  private static passwordMissing(): RemarkableResult<string> {
    return RemarkableCredentialStore.failure(
      'password-missing',
      'No reMarkable password is configured for this host',
    )
  }

  private static credentialDamaged(): RemarkableResult<string> {
    return RemarkableCredentialStore.failure(
      'credential-unavailable',
      'The stored reMarkable credential is damaged',
    )
  }

  private static failure<T = undefined>(
    code: RemarkableErrorCode,
    detail: string,
  ): RemarkableResult<T> {
    return { ok: false, code, detail, retryable: false }
  }
}
