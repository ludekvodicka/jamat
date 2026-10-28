import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexIdentityProbe } from './codexIdentityProbe'
import type { CommandInvocation } from '../../shared/commandInvoker.types'
import { AccountProblem } from '../accountProblem'

const temp = resolve(import.meta.dirname, '../../../.aidocs/temp')
const roots: string[] = []
const configuration = { identityStore: async () => {} }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(temp, { recursive: true })
  const home = mkdtempSync(join(temp, 'codex-identity-'))
  roots.push(home)
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-account',
    access_token: 'DO_NOT_RETURN_ACCESS', refresh_token: 'DO_NOT_RETURN_REFRESH', id_token: 'DO_NOT_DECODE' } }))
  return home
}

it('extracts only account_id and uses the status exit state without exposing command output', async () => {
  const home = fixture()
  const run = vi.fn(async (_invocation: CommandInvocation) => ({ code: 0, failure: null, stdout: 'SENSITIVE_STDOUT', stderr: 'SENSITIVE_STDERR' }))
  const result = await new CodexIdentityProbe({ PATH: 'fixture-path', JAMAT_V3_TOKEN: 'removed' }, { run }, configuration).read(home, temp)
  expect(result).toEqual({ kind: 'logged-in', identity: { key: 'fixture-account', label: 'fixture-account' } })
  expect(run.mock.calls[0][0]).toMatchObject({ cwd: home, timeoutMs: 10_000, retain: { tailBytes: 0 },
    env: { CODEX_HOME: home, CODEX_SQLITE_HOME: temp } })
  expect(run.mock.calls[0][0].env).not.toHaveProperty('JAMAT_V3_TOKEN')
  expect(run.mock.calls[0][0].args.slice(-2)).toEqual(['login', 'status'])
})

it('does not inspect tokens to recover a missing account identity or an API-key identity', async () => {
  expect(CodexIdentityProbe.parse(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'SENSITIVE_API_KEY' })))
    .toEqual({ kind: 'logged-out' })
  expect(CodexIdentityProbe.parse(JSON.stringify({ tokens: { id_token: 'SENSITIVE_TOKEN' } }))).toEqual({ kind: 'logged-out' })
  expect(CodexIdentityProbe.parse('{broken "access_token":"SENSITIVE"')).toEqual({ kind: 'failed', reason: 'Codex identity metadata is not JSON' })
  const run = vi.fn()
  expect(await new CodexIdentityProbe({}, { run }).read(join(temp, 'absent-codex-profile'), temp)).toEqual({ kind: 'logged-out' })
  expect(run).not.toHaveBeenCalled()
})

it('keeps failed status output out of the account result', async () => {
  const home = fixture()
  const run = vi.fn(async () => ({ code: 1, failure: null, stdout: '', stderr: 'SENSITIVE_API_KEY' }))
  expect(await new CodexIdentityProbe({}, { run }, configuration).read(home, temp)).toEqual({ kind: 'logged-out' })
  const failed = vi.fn(async () => ({ code: -1, failure: 'timeout' as const, stdout: 'SECRET', stderr: 'SECRET' }))
  expect(await new CodexIdentityProbe({}, { run: failed }, configuration).read(home, temp))
    .toEqual({ kind: 'failed', reason: 'Codex login status could not be checked' })
})

it('refuses stale file identity under unsupported storage or environment authentication without running status', async () => {
  const home = fixture(), run = vi.fn()
  const unsupported = { identityStore: async () => { throw new AccountProblem('Codex accounts require file credential storage') } }
  expect(await new CodexIdentityProbe({}, { run }, unsupported).read(home, temp))
    .toEqual({ kind: 'failed', reason: 'Codex accounts require file credential storage' })
  expect(await new CodexIdentityProbe({ CODEX_ACCESS_TOKEN: 'SYNTHETIC_ENV_SECRET' }, { run }, configuration).read(home, temp))
    .toEqual({ kind: 'failed', reason: 'Codex environment authentication is not supported for account identity checks' })
  expect(run).not.toHaveBeenCalled()
})
