import { describe, expect, it, vi } from 'vitest'
import { AccountProblem } from '../accountProblem'
import { WindowsAntigravityKeyring } from './windowsAntigravityKeyring'

describe('lib-orchestrator/agentAccounts/antigravity/windowsAntigravityKeyring', () => {
  it('disables itself off Windows and when JAMAT_V3_GEMINI_DIR is set', async () => {
    const run = vi.fn()
    const linux = new WindowsAntigravityKeyring({ platform: 'linux', environment: {}, invoker: { run } })
    expect(linux.available).toBe(false)
    expect(linux.unavailableReason).toContain('Windows')
    await expect(linux.inspect()).rejects.toThrow(AccountProblem)

    const smoke = new WindowsAntigravityKeyring({
      platform: 'win32',
      environment: { JAMAT_V3_GEMINI_DIR: 'C:\\temp\\fixture' },
      invoker: { run },
    })
    expect(smoke.available).toBe(false)
    expect(smoke.unavailableReason).toContain('JAMAT_V3_GEMINI_DIR')
    await expect(smoke.clear()).rejects.toThrow(AccountProblem)
    expect(run).not.toHaveBeenCalled()
  })

  it('encodes and decodes metadata within Windows Credential Manager comment bounds', () => {
    const encoded = WindowsAntigravityKeyring.encodeMeta({
      label: 'Alice',
      email: 'alice@example.com',
      planTier: 'Pro',
      savedAt: 1795273000000,
    })
    expect(encoded.length).toBeLessThanOrEqual(WindowsAntigravityKeyring.maxCommentLengthConst)
    expect(WindowsAntigravityKeyring.decodeMeta('alice-1234', encoded)).toEqual({
      label: 'Alice',
      email: 'alice@example.com',
      planTier: 'Pro',
      savedAt: 1795273000000,
    })

    const longEncoded = WindowsAntigravityKeyring.encodeMeta({
      label: 'a'.repeat(80),
      email: `${'b'.repeat(180)}@example.com`,
      planTier: 'c'.repeat(50),
      savedAt: 1795273000000,
    })
    expect(longEncoded.length).toBeLessThanOrEqual(WindowsAntigravityKeyring.maxCommentLengthConst)
    expect(WindowsAntigravityKeyring.decodeMeta('fallback', '{broken')).toEqual({
      label: 'fallback',
      email: null,
      planTier: null,
      savedAt: 0,
    })
  })

  it('parses inspect output including single-slot object shapes and ignores malformed slot ids', () => {
    const comment = WindowsAntigravityKeyring.encodeMeta({
      label: 'Bob',
      email: 'bob@example.com',
      planTier: 'Ultra',
      savedAt: 42,
    })
    const parsed = WindowsAntigravityKeyring.parseInspectOutput(JSON.stringify({
      present: true,
      currentHash: 'abc123',
      slots: [
        { id: 'bob-a1b2', comment, hash: 'abc123' },
        { id: '../escape', comment, hash: 'bad' },
      ],
    }))
    expect(parsed).toEqual({
      present: true,
      currentHash: 'abc123',
      slots: [{
        id: 'bob-a1b2',
        label: 'Bob',
        email: 'bob@example.com',
        planTier: 'Ultra',
        savedAt: 42,
        hash: 'abc123',
      }],
    })
  })

  it('passes parameters through JAMAT_V3_AGY_* env vars and maps PowerShell error codes', async () => {
    const run = vi.fn().mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({ present: false, currentHash: null, slots: [] }),
      stderr: '',
      failure: null,
    }).mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'NO_CURRENT_LOGIN',
      failure: null,
    }).mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'SLOT_NOT_FOUND',
      failure: null,
    })
    const keyring = new WindowsAntigravityKeyring({ platform: 'win32', environment: {}, invoker: { run } })

    expect(await keyring.inspect()).toEqual({ present: false, currentHash: null, slots: [] })
    expect(run.mock.calls[0]![0]).toMatchObject({
      command: 'powershell.exe',
      env: { JAMAT_V3_AGY_OP: 'inspect', JAMAT_V3_AGY_SLOT: '', JAMAT_V3_AGY_META: '' },
    })

    await expect(keyring.store('alice-1234', { label: 'Alice', email: null, planTier: null, savedAt: 1 }))
      .rejects.toThrow('No current Antigravity login found in Windows Credential Manager')
    await expect(keyring.activate('missing-1234'))
      .rejects.toThrow('Saved Antigravity login not found')
    await expect(keyring.activate('../bad')).rejects.toThrow('Invalid Antigravity login id')
  })
})
