import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from '../../../../lib-orchestrator/shared/atomicJsonFile'
import {
  RemarkableCredentialStore,
  type RemarkableSecretCipher,
} from './remarkableCredentialStore'

class FakeRemarkableSecretCipher implements RemarkableSecretCipher {
  availableValue = true
  shouldReEncrypt = false
  encryptCalls = 0
  decryptCalls = 0
  failureDetail = ''
  failEncrypt = false
  failDecrypt = false

  async available(): Promise<boolean> {
    return this.availableValue
  }

  async encrypt(value: string): Promise<Buffer> {
    this.encryptCalls += 1
    if (this.failEncrypt) throw new Error(this.failureDetail)
    return Buffer.from(`cipher-${this.encryptCalls}:${Buffer.from(value).toString('base64')}`, 'utf8')
  }

  async decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    this.decryptCalls += 1
    if (this.failDecrypt) throw new Error(this.failureDetail)
    const stored = value.toString('utf8')
    const separator = stored.indexOf(':')
    if (!stored.startsWith('cipher-') || separator < 0) throw new Error('invalid ciphertext')
    return {
      result: Buffer.from(stored.slice(separator + 1), 'base64').toString('utf8'),
      shouldReEncrypt: this.shouldReEncrypt,
    }
  }
}

describe('app-client-ui/app/remarkable/storage/remarkableCredentialStore', () => {
  let root: string
  let file: string
  let cipher: FakeRemarkableSecretCipher
  let store: RemarkableCredentialStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-remarkable-credential-'))
    file = join(root, 'profile', 'remarkable', 'credential.json')
    cipher = new FakeRemarkableSecretCipher()
    store = new RemarkableCredentialStore(file, 'config-identity-a', 'development', cipher)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('stores only ciphertext metadata and decrypts it for a matching main-process caller', async () => {
    const password = 'known-test-password'
    expect(await store.replace('remarkable.local', password))
      .toEqual({ ok: true, value: undefined })

    const storedText = readFileSync(file, 'utf8')
    expect(storedText).not.toContain(password)
    expect(JSON.parse(storedText)).toEqual({
      schemaVersion: 1,
      configIdentity: 'config-identity-a',
      channel: 'development',
      host: 'remarkable.local',
      encryptedBase64: expect.any(String),
      updatedAt: expect.any(String),
    })
    expect(store.configuredFor('remarkable.local')).toBe(true)
    expect(await store.passwordFor('remarkable.local')).toEqual({ ok: true, value: password })
  })

  it('never uses a record bound to another host or config identity', async () => {
    expect((await store.replace('remarkable.local', 'known-test-password')).ok).toBe(true)
    const otherIdentity = new RemarkableCredentialStore(
      file,
      'config-identity-b',
      'development',
      cipher,
    )

    expect(store.configuredFor('other.local')).toBe(false)
    expect(otherIdentity.configuredFor('remarkable.local')).toBe(false)
    expect(await store.passwordFor('other.local')).toEqual({
      ok: false,
      code: 'password-missing',
      detail: expect.any(String),
      retryable: false,
    })
    expect(await otherIdentity.passwordFor('remarkable.local')).toEqual({
      ok: false,
      code: 'password-missing',
      detail: expect.any(String),
      retryable: false,
    })
    expect(cipher.decryptCalls).toBe(0)
  })

  it('rejects plaintext scope metadata changed after encryption', async () => {
    expect((await store.replace('remarkable.local', 'known-test-password')).ok).toBe(true)
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    record['host'] = 'other.local'
    writeFileSync(file, JSON.stringify(record), 'utf8')

    expect(await store.passwordFor('other.local')).toEqual({
      ok: false,
      code: 'credential-unavailable',
      detail: 'The stored reMarkable credential is damaged',
      retryable: false,
    })
  })

  it('does not clear a credential bound to another channel or host', async () => {
    expect((await store.replace('remarkable.local', 'known-test-password')).ok).toBe(true)
    const otherChannel = new RemarkableCredentialStore(
      file,
      'config-identity-a',
      'production',
      cipher,
    )

    expect(await otherChannel.clear('remarkable.local')).toEqual({ ok: true, value: undefined })
    expect(await store.clear('other.local')).toEqual({ ok: true, value: undefined })
    expect(store.configuredFor('remarkable.local')).toBe(true)
  })

  it('refuses unavailable encryption without creating plaintext or a credential file', async () => {
    const password = 'known-test-password'
    cipher.availableValue = false
    const result = await store.replace('remarkable.local', password)

    expect(result).toEqual({
      ok: false,
      code: 'credential-unavailable',
      detail: expect.any(String),
      retryable: false,
    })
    expect(JSON.stringify(result)).not.toContain(password)
    expect(existsSync(file)).toBe(false)
  })

  it('returns a typed secret-free failure for damaged ciphertext', async () => {
    const password = 'known-test-password'
    expect((await store.replace('remarkable.local', password)).ok).toBe(true)
    cipher.failDecrypt = true
    cipher.failureDetail = password

    const result = await store.passwordFor('remarkable.local')
    expect(result).toEqual({
      ok: false,
      code: 'credential-unavailable',
      detail: 'The stored reMarkable credential is damaged',
      retryable: false,
    })
    expect(JSON.stringify(result)).not.toContain(password)
  })

  it('rejects malformed credential JSON before calling the cipher', async () => {
    AtomicJsonFile.ensureDirectory(join(root, 'profile', 'remarkable'))
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      configIdentity: 'config-identity-a',
      channel: 'development',
      host: 'remarkable.local',
      encryptedBase64: 'not-base64',
      updatedAt: new Date().toISOString(),
    }), 'utf8')

    expect(store.configuredFor('remarkable.local')).toBe(false)
    expect(await store.passwordFor('remarkable.local')).toEqual({
      ok: false,
      code: 'credential-unavailable',
      detail: expect.any(String),
      retryable: false,
    })
    expect(cipher.decryptCalls).toBe(0)
  })

  it('reports an atomic write failure without returning or writing plaintext', async () => {
    const password = 'known-test-password'
    vi.spyOn(AtomicJsonFile, 'write').mockImplementation(() => { throw new Error(password) })

    const result = await store.replace('remarkable.local', password)
    expect(result).toEqual({
      ok: false,
      code: 'credential-unavailable',
      detail: 'The reMarkable credential could not be stored securely',
      retryable: false,
    })
    expect(JSON.stringify(result)).not.toContain(password)
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toContain(password)
  })

  it('atomically refreshes ciphertext when the OS cipher requests re-encryption', async () => {
    const password = 'known-test-password'
    expect((await store.replace('remarkable.local', password)).ok).toBe(true)
    const before = JSON.parse(readFileSync(file, 'utf8')) as { encryptedBase64: string }
    cipher.shouldReEncrypt = true

    expect(await store.passwordFor('remarkable.local')).toEqual({ ok: true, value: password })
    const after = JSON.parse(readFileSync(file, 'utf8')) as { encryptedBase64: string }
    expect(after.encryptedBase64).not.toBe(before.encryptedBase64)
    expect(cipher.encryptCalls).toBe(2)
    expect(readFileSync(file, 'utf8')).not.toContain(password)
  })

  it('clears both the credential and an interrupted atomic-write temporary', async () => {
    expect((await store.replace('remarkable.local', 'known-test-password')).ok).toBe(true)
    writeFileSync(`${file}.tmp`, 'ciphertext only', 'utf8')

    expect(await store.clear('remarkable.local')).toEqual({ ok: true, value: undefined })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(store.configuredFor('remarkable.local')).toBe(false)
  })
})
