import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, type SpawnOptions } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentAccounts, type StoredAccount } from '../../agentAccounts/agentAccounts'
import type { AgentProfileSpec } from '../../agentAccounts/profiles/profileShareTable'
import { CodexIdentityProbe } from '../../agentAccounts/codex/codexIdentityProbe'
import { CodexProfileConfiguration } from '../../agentAccounts/codex/codexProfileConfiguration'
import { ProfileProvisioner } from '../../agentAccounts/profiles/profileProvisioner'
import { RateLimitSourceCodex } from './rateLimitSourceCodex'
import { FakeCodexAppServer, FakeCodexAppServerChild } from './fixtures/fakeCodexAppServer'
import { CommandInvoker } from '../../shared/commandInvoker'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

async function fixture() {
  const temp = resolve(import.meta.dirname, '../../../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'codex-exit-lifetime-')), main = join(root, 'main')
  mkdirSync(main)
  let stored: readonly StoredAccount[] = []
  const spec: AgentProfileSpec = { agentId: 'codex', mainHome: () => main,
    shareTable: { directories: [], files: [], neverShared: [] }, homeVariable: 'CODEX_HOME',
    extraEnv: () => ({}), loginCommand: 'unused', probe: async () => ({ kind: 'logged-in', identity: { key: 'fixture', label: 'fixture' } }) }
  const accounts = new AgentAccounts({ mainHomes: { codex: main, claude: main }, specs: [spec],
    stored: () => stored, store: value => { stored = value }, accountsRoot: join(root, 'accounts'),
    hasRunningSession: () => false, onChanged: () => {} })
  const { accountId } = await accounts.add('codex', 'Fixture')
  stored = stored.map(account => ({ ...account, identity: { key: 'fixture', label: 'fixture' } }))
  const home = accounts.homeOf('codex', accountId), marker = join(home, 'private-marker')
  writeFileSync(marker, 'keep until exit')
  return { accounts, accountId, spec, main, home, marker, root,
    dispose: () => { accounts.stop(); rmSync(root, { recursive: true, force: true }) } }
}

function source(context: Awaited<ReturnType<typeof fixture>>, server: FakeCodexAppServer) {
  return new RateLimitSourceCodex({ onNudge: () => {}, keepAlive: false, platform: 'linux', environment: {},
    spawnImpl: server.spawnImpl, withProfile: read => context.accounts.withProfile('codex', context.accountId, read) })
}

it.each(['live', 'retired'] as const)('refuses removal and replacement polls after close timeout while %s until actual exit', async state => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: true })
  const original = source(context, server), replacement = source(context, server)
  vi.useFakeTimers()
  try {
    const reading = original.read()
    await vi.waitFor(() => expect(server.children).toHaveLength(1))
    if (state === 'retired') original.stop()
    else if (state === 'live') expect(server.children).toHaveLength(1)
    else throw new Error(`Unknown source state: ${state}`)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await reading).toMatchObject({ kind: 'failed', reason: 'The Codex quota child did not stop' })
    expect(server.child.killed).toBe(true)
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    expect(readFileSync(context.marker, 'utf8')).toBe('keep until exit')
    expect(await replacement.read()).toMatchObject({ kind: 'failed', reason: 'The account has an operation in progress' })
    expect(server.children).toHaveLength(1)
    server.child.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    const recovered = replacement.read()
    await vi.waitFor(() => expect(server.children).toHaveLength(2))
    server.child.exit(0)
    expect((await recovered).kind).toBe('ok')
    await context.accounts.remove(context.accountId)
    expect(existsSync(context.home)).toBe(false)
  } finally { original.stop(); replacement.stop(); for (const child of server.children) child.exit(0); context.dispose() }
})

async function answerConfiguration(server: FakeCodexAppServer) {
  await vi.waitFor(() => expect(server.child.requestOf('config/read')).toBeDefined())
  server.child.answer(server.child.requestOf('config/read')!.id!, {
    config: { cli_auth_credentials_store: 'ephemeral' },
    layers: [{ name: { type: 'sessionFlags' }, version: 'fixture', config: { cli_auth_credentials_store: 'ephemeral' } }],
  })
  await vi.waitFor(() => expect(server.child.requestOf('configRequirements/read')).toBeDefined())
  server.child.answer(server.child.requestOf('configRequirements/read')!.id!, { requirements: null })
  await vi.advanceTimersByTimeAsync(0)
}

it.each(['preflight', 'identity'] as const)('retains the real configuration inspector profile after failed %s close', async operation => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: true })
  vi.mocked(spawn).mockImplementation(server.spawnImpl)
  const configuration = new CodexProfileConfiguration({}), command = { run: vi.fn() }
  const probe = new CodexIdentityProbe({}, command, configuration)
  if (operation === 'preflight')
    context.spec.beforeLaunch = (home, main, cwd, settings, retain) => configuration.verify(home, main, cwd ?? home, settings, retain)
  else if (operation === 'identity') {
    writeFileSync(join(context.home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture' } }))
    context.spec.probe = (home, retain) => home === context.main
      ? Promise.resolve({ kind: 'logged-out' }) : probe.read(home, context.main, retain)
  } else throw new Error(`Unknown profile operation: ${operation}`)
  vi.useFakeTimers()
  try {
    let request: Promise<unknown>
    if (operation === 'preflight') request = context.accounts.launchEnv('codex', context.accountId).then(() => null, error => error.message)
    else if (operation === 'identity') request = context.accounts.list()
    else throw new Error(`Unknown profile operation: ${operation}`)
    await answerConfiguration(server)
    await vi.advanceTimersByTimeAsync(2_000)
    if (operation === 'preflight') expect(await request).toBe('Codex configuration reader did not stop')
    else if (operation === 'identity') expect(await request).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: context.accountId, profileProblem: 'Codex configuration reader did not stop' })]))
    else throw new Error(`Unknown profile operation: ${operation}`)
    expect(command.run).not.toHaveBeenCalled()
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    expect(readFileSync(context.marker, 'utf8')).toBe('keep until exit')
    await expect(context.accounts.launchEnv('codex', context.accountId)).rejects.toThrow('operation in progress')
    expect(server.children).toHaveLength(1)
    server.child.exit(0)
    for (const killer of server.killerChildren) killer.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    await context.accounts.remove(context.accountId)
    expect(existsSync(context.home)).toBe(false)
  } finally { for (const child of server.children) child.exit(0); context.dispose() }
})

it('defers failed-add rollback until the configuration child exits without delaying the failed request', async () => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: true })
  vi.mocked(spawn).mockImplementation(server.spawnImpl)
  const configuration = new CodexProfileConfiguration({})
  context.spec.beforeLaunch = (home, main, cwd, settings, retain) => configuration.verify(home, main, cwd ?? home, settings, retain)
  vi.useFakeTimers()
  try {
    const adding = context.accounts.add('codex', 'Fails').then(() => null, error => error.message)
    await answerConfiguration(server)
    const home = server.invocations[0].options.cwd!
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await adding).toBe('Codex configuration reader did not stop')
    expect(existsSync(home)).toBe(true)
    expect(readdirSync(home)).toContain('.jamat-profile.json')
    server.child.exit(0)
    for (const killer of server.killerChildren) killer.exit(0)
    await vi.waitFor(() => expect(existsSync(home)).toBe(false))
    expect(existsSync(context.home)).toBe(true)
  } finally { for (const child of server.children) child.exit(0); context.dispose() }
})

it('retains every failed configuration attempt until the last actual exit', async () => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: true })
  vi.mocked(spawn).mockImplementation(server.spawnImpl)
  const configuration = new CodexProfileConfiguration({})
  context.spec.beforeLaunch = (home, main, cwd, settings, retain) => configuration.verify(home, main, cwd ?? home, settings, retain)
  vi.useFakeTimers()
  try {
    const request = context.accounts.launchEnv('codex', context.accountId).then(() => null, error => error.message)
    await vi.waitFor(() => expect(server.child.requestOf('config/read')).toBeDefined())
    server.child.refuse(server.child.requestOf('config/read')!.id!, 'first refusal')
    await vi.waitFor(() => expect(server.children).toHaveLength(2))
    server.child.refuse(server.child.requestOf('config/read')!.id!, 'second refusal')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await request).toBe('Codex configuration reader did not stop')
    server.child.exit(0)
    server.killerChildren[1]?.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    expect(readFileSync(context.marker, 'utf8')).toBe('keep until exit')
    await expect(context.accounts.launchEnv('codex', context.accountId)).rejects.toThrow('operation in progress')
    expect(server.children).toHaveLength(2)
    server.children[0].exit(0)
    server.killerChildren[0]?.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    await context.accounts.remove(context.accountId)
    expect(existsSync(context.home)).toBe(false)
  } finally { for (const child of server.children) child.exit(0); context.dispose() }
})

it('keeps a failed deferred rollback visible and removable after exit', async () => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: true })
  vi.mocked(spawn).mockImplementation(server.spawnImpl)
  const configuration = new CodexProfileConfiguration({})
  context.spec.beforeLaunch = (home, main, cwd, settings, retain) => configuration.verify(home, main, cwd ?? home, settings, retain)
  const remove = vi.spyOn(ProfileProvisioner.prototype, 'remove').mockRejectedValueOnce(new Error('fixture cleanup refusal'))
  vi.useFakeTimers()
  try {
    const adding = context.accounts.add('codex', 'Cleanup').then(() => null, error => error.message)
    await answerConfiguration(server)
    const home = server.invocations[0].options.cwd!
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await adding).toBe('Codex configuration reader did not stop')
    expect(remove).not.toHaveBeenCalled()
    server.child.exit(0)
    for (const killer of server.killerChildren) killer.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    const account = (await context.accounts.list()).find(value => value.label === 'Cleanup')!
    expect(account).toMatchObject({ state: 'disabled', identity: null, profileProblem: 'Profile cleanup failed: fixture cleanup refusal' })
    expect(existsSync(home)).toBe(true)
    await context.accounts.remove(account.accountId)
    expect(existsSync(home)).toBe(false)
  } finally { for (const child of server.children) child.exit(0); context.dispose() }
})

it('refuses another poll on a closing standalone source even without the optional profile callback', async () => {
  const server = new FakeCodexAppServer({ autoAnswer: true })
  const readingSource = new RateLimitSourceCodex({ onNudge: () => {}, keepAlive: false, platform: 'linux', environment: {}, spawnImpl: server.spawnImpl })
  vi.useFakeTimers()
  try {
    const reading = readingSource.read()
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await reading).kind).toBe('failed')
    expect(await readingSource.read()).toMatchObject({ kind: 'failed', reason: 'The Codex quota child did not stop' })
    expect(server.children).toHaveLength(1)
    server.child.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    const next = readingSource.read()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.children).toHaveLength(2)
    server.child.exit(0)
    expect((await next).kind).toBe('ok')
  } finally { readingSource.stop(); for (const child of server.children) child.exit(0) }
})

it.each([
  ['error', false], ['error', true], ['refused', false], ['refused', true], ['throws', false],
] as const)('retains the Windows profile after tree termination %s, wrapper-first=%s', async (outcome, wrapperFirst) => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: true })
  const killer = new FakeCodexAppServerChild(9000, {})
  const spawnImpl = ((command: string, args: readonly string[], options: SpawnOptions) => {
    if (command !== 'taskkill') return server.spawnImpl(command, args, options)
    if (outcome === 'throws') throw new Error('fixture taskkill startup failure')
    else if (outcome === 'error' || outcome === 'refused') return killer
    else throw new Error(`Unknown termination outcome: ${outcome}`)
  }) as unknown as typeof spawn
  const readingSource = new RateLimitSourceCodex({ onNudge: () => {}, keepAlive: false, platform: 'win32', environment: {},
    spawnImpl, withProfile: read => context.accounts.withProfile('codex', context.accountId, read) })
  const descendant = new FakeCodexAppServerChild(9002, {})
  vi.useFakeTimers()
  try {
    const reading = readingSource.read()
    await vi.waitFor(() => expect(server.children).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(500)
    if (wrapperFirst) { server.child.exit(null, 'SIGTERM'); server.child.emit('close', null, 'SIGTERM') }
    if (outcome === 'error') killer.emit('error', new Error('fixture taskkill startup error'))
    else if (outcome === 'refused') killer.emit('exit', 1)
    else if (outcome === 'throws') expect(server.child.killed).toBe(true)
    else throw new Error(`Unknown termination outcome: ${outcome}`)
    if (!wrapperFirst) { server.child.exit(null, 'SIGTERM'); server.child.emit('close', null, 'SIGTERM') }
    readingSource.stop()
    readingSource.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await reading).toMatchObject({ kind: 'failed', reason: 'The Codex quota child did not stop' })
    expect(descendant.exitCode).toBeNull()
    expect(descendant.killed).toBe(false)
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    expect(readFileSync(context.marker, 'utf8')).toBe('keep until exit')
    const replacement = source(context, server)
    expect((await replacement.read()).kind).toBe('failed')
    expect(server.children).toHaveLength(1)
    replacement.stop()
  } finally { descendant.exit(0); readingSource.stop(); context.dispose() }
})

it.each(['natural', 'tree'] as const)('releases the status profile after confirmed Windows %s completion', async completion => {
  const context = await fixture(), status = new FakeCodexAppServerChild(9200, {}), killer = new FakeCodexAppServerChild(9201, {})
  const spawnImpl = vi.fn((command: string) => command === 'taskkill' ? killer : status) as unknown as typeof spawn
  const probe = new CodexIdentityProbe({}, new CommandInvoker({ spawnImpl, platform: 'win32' }), { identityStore: async () => {} })
  writeFileSync(join(context.home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture' } }))
  context.spec.probe = (home, retain) => probe.read(home, context.main, retain)
  vi.useFakeTimers()
  try {
    const request = context.accounts.launchEnv('codex', context.accountId).then(() => 'ready', error => error.message)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledOnce())
    if (completion === 'tree') {
      await vi.advanceTimersByTimeAsync(10_000)
      status.exit(null, 'SIGTERM')
      killer.emit('exit', 0)
      status.emit('close', null, 'SIGTERM')
      expect(await request).toBe('Codex login status could not be checked')
    } else if (completion === 'natural') {
      status.exit(0)
      status.emit('close', 0)
      expect(await request).toBe('ready')
    } else throw new Error(`Unknown completion: ${completion}`)
    await context.accounts.remove(context.accountId)
    expect(existsSync(context.home)).toBe(false)
  } finally { status.exit(0); status.emit('close', 0); context.dispose() }
})

it.each(['linux', 'win32'] as const)('retains the actual login-status command after its bounded timeout on %s', async platform => {
  const context = await fixture(), status = new FakeCodexAppServerChild(9100, {}), killer = new FakeCodexAppServerChild(9101, {})
  const spawnImpl = vi.fn((command: string) => command === 'taskkill' ? killer : status) as unknown as typeof spawn
  const command = new CommandInvoker({ spawnImpl, platform })
  const probe = new CodexIdentityProbe({}, command, { identityStore: async () => {} })
  writeFileSync(join(context.home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture' } }))
  context.spec.probe = (home, retain) => home === context.main
    ? Promise.resolve({ kind: 'logged-out' }) : probe.read(home, context.main, retain)
  vi.useFakeTimers()
  try {
    const request = context.accounts.launchEnv('codex', context.accountId).then(() => null, error => error.message)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledOnce())
    status.stdout.emit('data', Buffer.from('synthetic stdout must never escape'))
    status.stderr.emit('data', Buffer.from('synthetic stderr must never escape'))
    await vi.advanceTimersByTimeAsync(10_000)
    if (platform === 'win32') {
      killer.emit('exit', 1)
      status.exit(null, 'SIGTERM')
      status.emit('close', null, 'SIGTERM')
    } else if (platform === 'linux') expect(status.killed).toBe(true)
    else throw new Error(`Unknown test platform: ${platform}`)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await request).toBe('Codex login status could not be checked')
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    expect(readFileSync(context.marker, 'utf8')).toBe('keep until exit')
    await expect(context.accounts.launchEnv('codex', context.accountId)).rejects.toThrow('operation in progress')
    if (platform === 'win32') expect(spawnImpl).toHaveBeenCalledTimes(2)
    else if (platform === 'linux') expect(spawnImpl).toHaveBeenCalledTimes(1)
    else throw new Error(`Unknown test platform: ${platform}`)
    if (platform === 'linux') {
      status.exit(0)
      status.emit('close', 0)
      await vi.advanceTimersByTimeAsync(0)
      await context.accounts.remove(context.accountId)
      expect(existsSync(context.home)).toBe(false)
    } else if (platform === 'win32') expect(existsSync(context.home)).toBe(true)
    else throw new Error(`Unknown test platform: ${platform}`)
  } finally { status.exit(0); status.emit('close', 0); context.dispose() }
})
