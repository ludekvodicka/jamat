import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAccounts, type AgentAccountsDeps, type StoredAccount } from './agentAccounts'
import { claudeShareTable } from './claude/claudeProfile'
import { mergeClaudeJson } from './claude/claudeJsonMerge'
import type { IdentityProbe } from './profiles/profileShareTable'
import { ClaudeIdentityProbe } from './claude/claudeIdentityProbe'

describe('AgentAccounts', () => {
  let root: string
  let main: string
  let stored: readonly StoredAccount[]
  let busy: boolean
  let accounts: AgentAccounts
  const probe = vi.fn<(home: string) => Promise<IdentityProbe>>()
  let terminal: { ended: false } | { ended: true; exitCode: number | null }
  const openLogin = vi.fn<NonNullable<AgentAccountsDeps['login']>['open']>(async () => ({ sessionId: 'login-terminal' }))
  const stopLogin = vi.fn(async () => { terminal = { ended: true, exitCode: null }; busy = false })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-accounts-'))
    main = join(root, 'main')
    mkdirSync(main)
    writeFileSync(join(main, 'settings.json'), '{}')
    writeFileSync(join(root, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true,
      mcpServers: { test: { command: 'fixture-server' } }, oauthAccount: { ignored: true } }))
    stored = []
    busy = false
    probe.mockReset().mockResolvedValue({ kind: 'logged-out' })
    openLogin.mockClear()
    stopLogin.mockClear()
    terminal = { ended: false }
    accounts = new AgentAccounts({ mainHomes: { claude: main, codex: join(root, 'codex') },
      specs: [{ agentId: 'claude', mainHome: () => main, shareTable: claudeShareTable,
        homeVariable: 'CLAUDE_CONFIG_DIR', extraEnv: () => ({}), loginCommand: 'claude auth login',
        probe, beforeLaunch: async home => mergeClaudeJson(home, join(root, '.claude.json')) }],
      stored: () => stored, store: value => { stored = value }, accountsRoot: join(root, 'accounts'),
      login: { open: openLogin, result: () => terminal, stop: stopLogin },
      hasRunningSession: () => busy, onChanged: () => {},
    })
  })

  afterEach(async () => {
    accounts.stop()
    vi.useRealTimers()
    busy = false
    for (const account of [...stored]) await accounts.remove(account.id)
    rmSync(root, { recursive: true, force: true })
  })

  it('synthesizes two main accounts without storing or provisioning them and caches the probe', async () => {
    expect((await accounts.list()).map(a => [a.agentId, a.accountId, a.isMain])).toEqual([
      ['claude', 'main', true], ['codex', 'main', true],
    ])
    await accounts.list()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(stored).toEqual([])
    expect(existsSync(join(root, 'accounts'))).toBe(false)
  })

  it('creates pending profiles, seeds only onboarding and MCP, and keeps the id on rename', async () => {
    const a = await accounts.add('claude', 'Work')
    const b = await accounts.add('claude', 'Work')
    expect(a.accountId).not.toBe(b.accountId)
    expect((await accounts.list()).find(item => item.accountId === a.accountId)?.state).toBe('pending-login')
    expect(JSON.parse(readFileSync(join(accounts.homeOf('claude', a.accountId), '.claude.json'), 'utf8'))).toEqual({
      hasCompletedOnboarding: true, mcpServers: { test: { command: 'fixture-server' } },
    })
    await accounts.rename(a.accountId, 'Renamed')
    expect(stored.find(item => item.id === a.accountId)?.label).toBe('Renamed')
    await accounts.setEnabled(a.accountId, false)
    expect((await accounts.list()).find(item => item.accountId === a.accountId)?.state).toBe('disabled')
  })

  it('refuses main mutations and removal of an account running a session', async () => {
    await expect(accounts.remove('main')).rejects.toThrow('main account')
    await expect(accounts.rename('main', 'Renamed')).rejects.toThrow('main account')
    const a = await accounts.add('claude', 'Busy')
    busy = true
    await expect(accounts.remove(a.accountId)).rejects.toThrow('a session runs on Busy')
    expect(existsSync(accounts.homeOf('claude', a.accountId))).toBe(true)
    expect(stored).toHaveLength(1)
  })

  it('resolves the current label for session badges without probing identity', async () => {
    const added = await accounts.add('claude', 'Work')
    expect(accounts.labelOf('claude', 'main')).toBeNull()
    expect(accounts.labelOf('claude', added.accountId)).toBe('Work')
    await accounts.rename(added.accountId, 'Renamed')
    expect(accounts.labelOf('claude', added.accountId)).toBe('Renamed')
    expect(accounts.labelOf('claude', 'removed')).toBe('removed')
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps independent concurrent creates when each finishes', async () => {
    await Promise.all([accounts.add('claude', 'A'), accounts.add('claude', 'B')])
    expect(stored.map(account => account.label).sort()).toEqual(['A', 'B'])
  })

  it('registers local metadata only after the login terminal succeeds', async () => {
    vi.useFakeTimers()
    const { accountId } = await accounts.add('claude', 'Login')
    const home = accounts.homeOf('claude', accountId)
    probe.mockImplementation(async file => file === main ? { kind: 'logged-out' } : { kind: 'logged-in', identity: { key: 'org/second', label: 'second' } })
    expect(await accounts.login(accountId)).toEqual({ sessionId: 'login-terminal' })
    expect(openLogin).toHaveBeenCalledWith({ accountId, agentId: 'claude', home, label: 'Login', command: 'claude auth login', prepare: expect.any(Function) })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stored[0]!.identity).toBeNull()
    terminal = { ended: true, exitCode: 0 }
    accounts.sessionsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(stored[0]!.identity).toEqual({ key: 'org/second', label: 'second' })
    expect((await accounts.list()).find(view => view.accountId === accountId)?.state).toBe('active')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains duplicate pending accounts with the other account label', async () => {
    vi.useFakeTimers()
    const first = await accounts.add('claude', 'Work')
    stored = stored.map(item => ({ ...item, identity: { key: 'org/work', label: 'work' } }))
    const second = await accounts.add('claude', 'Duplicate')
    probe.mockImplementation(async file => file === main ? { kind: 'logged-out' } : { kind: 'logged-in', identity: { key: 'org/work', label: 'work' } })
    await accounts.login(second.accountId)
    terminal = { ended: true, exitCode: 0 }
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await accounts.list()).find(view => view.accountId === second.accountId)).toMatchObject({ state: 'pending-login', profileProblem: 'already added as Work' })
    expect(stored.find(item => item.id === first.accountId)!.identity?.key).toBe('org/work')
    await expect(accounts.launchEnv('claude', second.accountId)).rejects.toThrow('already added as Work')
    expect((await accounts.list()).find(view => view.accountId === second.accountId)?.profileProblem).toBe('already added as Work')
  })

  it('rejects a main-account duplicate and a changed relogin identity', async () => {
    vi.useFakeTimers()
    const { accountId } = await accounts.add('claude', 'Work')
    probe.mockResolvedValue({ kind: 'logged-in', identity: { key: 'org/main', label: 'main' } })
    await accounts.login(accountId)
    terminal = { ended: true, exitCode: 0 }
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await accounts.list()).find(view => view.accountId === accountId)?.profileProblem).toBe('already added as Main')
    stored = stored.map(item => ({ ...item, identity: { key: 'org/original', label: 'original' } }))
    terminal = { ended: false }
    await accounts.login(accountId)
    terminal = { ended: true, exitCode: 0 }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stored[0]!.identity).toEqual({ key: 'org/original', label: 'original' })
    expect((await accounts.list()).find(view => view.accountId === accountId)).toMatchObject({ state: 'needs-login', profileProblem: 'Log in again must use the same account identity' })
  })

  it.each([0, 1])('removes a pending profile after terminal exit %s without identity', async exitCode => {
    vi.useFakeTimers()
    const { accountId } = await accounts.add('claude', 'Cancel')
    const home = accounts.homeOf('claude', accountId)
    const mainBytes = readFileSync(join(main, 'settings.json'), 'utf8')
    await accounts.login(accountId)
    terminal = { ended: true, exitCode }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stored).toEqual([])
    expect(existsSync(home)).toBe(false)
    expect(readFileSync(join(main, 'settings.json'), 'utf8')).toBe(mainBytes)
  })

  it('stops the login terminal at 15 minutes before removing the pending profile', async () => {
    vi.useFakeTimers()
    const { accountId } = await accounts.add('claude', 'Timeout')
    await accounts.login(accountId)
    busy = true
    await expect(accounts.remove(accountId)).rejects.toThrow('login in progress')
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
    expect(stored).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(stopLogin).toHaveBeenCalledExactlyOnceWith('login-terminal')
    expect(stored).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not delete a profile if stopping its timed-out terminal fails', async () => {
    vi.useFakeTimers()
    const { accountId } = await accounts.add('claude', 'Timeout')
    stopLogin.mockRejectedValueOnce(new Error('Host unavailable'))
    await accounts.login(accountId)
    busy = true
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(stored).toHaveLength(1)
    expect((await accounts.list()).find(view => view.accountId === accountId)?.profileProblem).toBe('Host unavailable')
    await expect(accounts.remove(accountId)).rejects.toThrow('a session runs on Timeout')
  })

  it('requires registration for ordinary launches and grants one initial login preparation only', async () => {
    const { accountId } = await accounts.add('claude', 'Pending')
    await expect(accounts.launchEnv('claude', accountId)).rejects.toThrow('Account login is not registered')
    const originalMain = readFileSync(join(main, 'settings.json'), 'utf8')
    openLogin.mockImplementationOnce(async request => {
      expect(await request.prepare()).toEqual({ CLAUDE_CONFIG_DIR: accounts.homeOf('claude', accountId) })
      await expect(accounts.launchEnv('claude', accountId)).rejects.toThrow('login in progress')
      expect(() => request.prepare()).toThrow('Login preparation is no longer available')
      return { sessionId: 'login-terminal' }
    })
    await accounts.login(accountId)
    expect(readFileSync(join(main, 'settings.json'), 'utf8')).toBe(originalMain)
    accounts.stop()
    await expect(accounts.launchEnv('claude', accountId)).rejects.toThrow('login in progress')
  })

  it.each([
    [{ kind: 'logged-in', identity: { key: 'org/other', label: 'other' } }, 'same account identity'],
    [{ kind: 'logged-out' }, 'Account needs login'],
    [{ kind: 'failed', reason: 'Metadata is unreadable' }, 'Metadata is unreadable'],
  ] satisfies [IdentityProbe, string][])('checks fresh identity before each normal launch: %j', async (changed, reason) => {
    const { accountId } = await accounts.add('claude', 'Registered')
    const identity = { key: 'org/work', label: 'work' }
    stored = stored.map(account => ({ ...account, identity }))
    probe.mockResolvedValue({ kind: 'logged-in', identity })
    expect((await accounts.list()).find(view => view.accountId === accountId)?.state).toBe('active')
    expect(await accounts.launchEnv('claude', accountId)).toEqual({ CLAUDE_CONFIG_DIR: accounts.homeOf('claude', accountId) })
    probe.mockResolvedValue(changed)
    await expect(accounts.launchEnv('claude', accountId)).rejects.toThrow(reason)
    expect((await accounts.list()).find(view => view.accountId === accountId)?.profileProblem).toContain(reason)
    expect(stored[0]!.identity).toEqual(identity)
    expect(await accounts.launchEnv('claude', 'main')).toEqual({})
  })

  it('parses identity without returning any other response fields', () => {
    expect(ClaudeIdentityProbe.parse(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test', organizationUuid: 'org' },
      accessToken: 'fixture-token', refreshToken: 'fixture-refresh' }))).toEqual({
      kind: 'logged-in', identity: { key: 'org/a@example.test', label: 'a@example.test' },
    })
    expect(ClaudeIdentityProbe.parse('{}')).toEqual({ kind: 'logged-out' })
    expect(ClaudeIdentityProbe.parse('broken')).toMatchObject({ kind: 'failed' })
  })
})
