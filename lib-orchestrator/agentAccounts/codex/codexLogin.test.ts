import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentAccounts, type StoredAccount } from '../agentAccounts'
import { codexProfileEnvironment, codexShareTable } from './codexProfile'
import type { IdentityProbe } from '../profiles/profileShareTable'
import { CodexIdentityProbe } from './codexIdentityProbe'

it('waits for successful Codex terminal completion even when retained identity already reports logged in', async () => {
  const temp = resolve(import.meta.dirname, '../../../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'codex-login-')), main = join(root, 'main')
  mkdirSync(main)
  let stored: readonly StoredAccount[] = []
  let ended = false
  const probe = vi.fn(async (home: string): Promise<IdentityProbe> => home === main ? { kind: 'logged-out' }
    : { kind: 'logged-in', identity: { key: 'retained-fixture-account', label: 'retained-fixture-account' } })
  const accounts = new AgentAccounts({ mainHomes: { codex: main, claude: join(root, 'claude') },
    specs: [{ agentId: 'codex', mainHome: () => main, shareTable: codexShareTable, homeVariable: 'CODEX_HOME',
      extraEnv: codexProfileEnvironment, loginCommand: 'codex login', probe }],
    stored: () => stored, store: value => { stored = value }, accountsRoot: join(root, 'accounts'),
    hasRunningSession: () => false, onChanged: () => {}, login: {
      open: async request => { expect(request.command).toBe('codex login'); return { sessionId: 'login' } },
      result: () => ended ? { ended: true, exitCode: 0 } : { ended: false }, stop: async () => {},
    } })
  vi.useFakeTimers()
  try {
    expect(await accounts.launchEnv('codex', 'main')).toEqual({})
    const { accountId } = await accounts.add('codex', 'Second')
    await accounts.login(accountId)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stored[0]!.identity).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    ended = true
    accounts.sessionsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(stored[0]!.identity?.key).toBe('retained-fixture-account')
    expect(probe).toHaveBeenCalledTimes(2)
    expect(await accounts.launchEnv('codex', accountId)).toEqual({ CODEX_HOME: accounts.homeOf('codex', accountId), CODEX_SQLITE_HOME: main })
    await accounts.remove(accountId)
  } finally {
    accounts.stop()
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['malformed = [', 'cli_auth_credentials_store="keyring"'])('repairs replaced Codex config before fresh identity inspection: %s', async replacement => {
  const temp = resolve(import.meta.dirname, '../../../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'codex-repair-')), main = join(root, 'main')
  mkdirSync(main)
  const valid = 'cli_auth_credentials_store="file"'
  writeFileSync(join(main, 'config.toml'), valid)
  let stored: readonly StoredAccount[] = []
  const inspector = { identityStore: async (home: string) => {
    if (readFileSync(join(home, 'config.toml'), 'utf8') !== valid) throw new Error('Configuration is not usable')
  } }
  const identity = new CodexIdentityProbe({}, { run: vi.fn(async () => ({ code: 0, failure: null, stdout: '', stderr: '' })) }, inspector)
  const accounts = new AgentAccounts({ mainHomes: { codex: main, claude: join(root, 'claude') },
    specs: [{ agentId: 'codex', mainHome: () => main, shareTable: codexShareTable, homeVariable: 'CODEX_HOME',
      extraEnv: codexProfileEnvironment, loginCommand: 'codex login', probe: home => identity.read(home, main) }],
    stored: () => stored, store: value => { stored = value }, accountsRoot: join(root, 'accounts'),
    hasRunningSession: () => false, onChanged: () => {} })
  try {
    const { accountId } = await accounts.add('codex', 'Repair')
    stored = stored.map(account => ({ ...account, identity: { key: 'fixture', label: 'fixture' } }))
    const home = accounts.homeOf('codex', accountId), config = join(home, 'config.toml')
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture' } }))
    unlinkSync(config)
    writeFileSync(config, replacement)
    expect(await accounts.launchEnv('codex', accountId)).toEqual({ CODEX_HOME: home, CODEX_SQLITE_HOME: main })
    expect(lstatSync(config).isSymbolicLink()).toBe(true)
    expect(readFileSync(config, 'utf8')).toBe(valid)
    const preserved = readdirSync(home).find(name => name.startsWith('config.toml.replaced-'))!
    expect(readFileSync(join(home, preserved), 'utf8')).toBe(replacement)
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'changed' } }))
    await expect(accounts.launchEnv('codex', accountId)).rejects.toThrow('same account identity')
    await accounts.remove(accountId)
  } finally { accounts.stop(); rmSync(root, { recursive: true, force: true }) }
})
