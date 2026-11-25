import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandInvocation, CommandOutcome } from '../../shared/commandInvoker.types'
import { AccountProblem } from '../accountProblem'
import { WindowsAntigravityKeyring } from './windowsAntigravityKeyring'

describe('lib-orchestrator/agentAccounts/antigravity/windowsAntigravityKeyring', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function directory(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-agy-keyring-'))
    roots.push(root)
    return root
  }

  const ok = (stdout: string): CommandOutcome => ({ code: 0, stdout, stderr: '', failure: null })
  const failed = (stderr: string): CommandOutcome => ({ code: 1, stdout: '', stderr, failure: null })
  const emptyInspect = JSON.stringify({ present: false, currentHash: null, slots: [] })

  /** Stands in for powershell.exe: a compile writes the requested file, an operation answers from `answers`. */
  function powershell(answers: CommandOutcome[]) {
    return vi.fn(async (invocation: CommandInvocation): Promise<CommandOutcome> => {
      const env = invocation.env ?? {}
      if (env.JAMAT_V3_AGY_OP === undefined) {
        writeFileSync(env.JAMAT_V3_AGY_ASSEMBLY!, 'compiled')
        return ok('')
      }
      const next = answers.shift()
      if (!next) throw new Error('unexpected operation')
      return next
    })
  }

  const operations = (run: ReturnType<typeof powershell>) =>
    run.mock.calls.map(([invocation]) => invocation.env?.JAMAT_V3_AGY_OP ?? 'compile')
  it('disables itself off Windows and when JAMAT_V3_GEMINI_DIR is set', async () => {
    const run = vi.fn()
    const linux = new WindowsAntigravityKeyring({ assemblyDirectory: directory(), platform: 'linux', environment: {}, invoker: { run } })
    expect(linux.available).toBe(false)
    expect(linux.unavailableReason).toContain('Windows')
    await expect(linux.inspect()).rejects.toThrow(AccountProblem)

    const smoke = new WindowsAntigravityKeyring({
      assemblyDirectory: directory(),
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
    const run = powershell([ok(emptyInspect), failed('NO_CURRENT_LOGIN'), failed('SLOT_NOT_FOUND')])
    const assemblyDirectory = directory()
    const keyring = new WindowsAntigravityKeyring({ assemblyDirectory, platform: 'win32', environment: {}, invoker: { run } })

    expect(await keyring.inspect()).toEqual({ present: false, currentHash: null, slots: [] })
    expect(run.mock.calls[1]![0]).toMatchObject({
      command: 'powershell.exe',
      cwd: assemblyDirectory,
      env: {
        JAMAT_V3_AGY_ASSEMBLY: join(assemblyDirectory, WindowsAntigravityKeyring.assemblyFileName()),
        JAMAT_V3_AGY_OP: 'inspect',
        JAMAT_V3_AGY_SLOT: '',
        JAMAT_V3_AGY_META: '',
      },
    })

    await expect(keyring.store('alice-1234', { label: 'Alice', email: null, planTier: null, savedAt: 1 }))
      .rejects.toThrow('No current Antigravity login found in Windows Credential Manager')
    await expect(keyring.activate('missing-1234'))
      .rejects.toThrow('Saved Antigravity login not found')
    await expect(keyring.activate('../bad')).rejects.toThrow('Invalid Antigravity login id')
  })

  it('compiles the helper once per source version and only loads it afterwards', async () => {
    expect(WindowsAntigravityKeyring.operationScriptConst).not.toContain('-TypeDefinition')
    expect(WindowsAntigravityKeyring.compileScriptConst).toContain('-OutputAssembly')
    const assemblyDirectory = directory()
    writeFileSync(join(assemblyDirectory, 'JamatWinCred-0000000000000000.dll'), 'older helper')
    const run = powershell([ok(emptyInspect), ok(emptyInspect), ok(emptyInspect)])
    const first = new WindowsAntigravityKeyring({ assemblyDirectory, platform: 'win32', environment: {}, invoker: { run } })

    await Promise.all([first.inspect(), first.inspect()])
    const second = new WindowsAntigravityKeyring({ assemblyDirectory, platform: 'win32', environment: {}, invoker: { run } })
    await second.inspect()

    expect(operations(run)).toEqual(['compile', 'inspect', 'inspect', 'inspect'])
    expect(readdirSync(assemblyDirectory)).toEqual([WindowsAntigravityKeyring.assemblyFileName()])
  })

  it('rebuilds a helper that no longer loads and runs the operation again', async () => {
    const assemblyDirectory = directory()
    const assembly = join(assemblyDirectory, WindowsAntigravityKeyring.assemblyFileName())
    writeFileSync(assembly, 'truncated')
    const run = powershell([failed('ASSEMBLY_LOAD_FAILED'), ok('{"ok":true}')])
    const keyring = new WindowsAntigravityKeyring({ assemblyDirectory, platform: 'win32', environment: {}, invoker: { run } })

    await keyring.clear()

    expect(operations(run)).toEqual(['clear', 'compile', 'clear'])
    expect(existsSync(assembly)).toBe(true)
  })

  it('reports a failed build without leaving a helper file behind', async () => {
    const assemblyDirectory = directory()
    const run = vi.fn(async (): Promise<CommandOutcome> => failed('csc failed'))
    const keyring = new WindowsAntigravityKeyring({ assemblyDirectory, platform: 'win32', environment: {}, invoker: { run } })

    await expect(keyring.inspect()).rejects.toThrow('Windows Credential Manager operation failed')
    await expect(keyring.inspect()).rejects.toThrow('Windows Credential Manager operation failed')

    expect(run).toHaveBeenCalledTimes(2)
    expect(readdirSync(assemblyDirectory)).toEqual([])
  })
})
