import type { spawn } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexAppServerClient } from './codexAppServerClient'
import { CodexRateLimitFixtures } from './fixtures/codexRateLimitFixtures'
import {
  FakeCodexAppServer,
  type FakeCodexAppServerChild,
} from './fixtures/fakeCodexAppServer'

describe('lib-orchestrator/rateMonitor/codex/codexAppServerClient', () => {
  /**
   * cmd.exe's own words when a command is not on PATH, verbatim including the line break: the win32
   * wrap turns a missing Codex into this instead of into an ENOENT, so this string is the signal.
   */
  const notRecognizedConst
    = "'codex' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"

  const clients: CodexAppServerClient[] = []
  const notifications: string[] = []

  afterEach(() => {
    for (const client of clients.splice(0)) client.stop()
    notifications.length = 0
    vi.useRealTimers()
  })

  const homeConst = '/home/somebody'

  function clientOf(
    server: FakeCodexAppServer,
    options?: {
      platform?: NodeJS.Platform
      environment?: NodeJS.ProcessEnv
      homeDirectory?: string
    },
  ): CodexAppServerClient {
    const client = new CodexAppServerClient({
      onNotification: (method) => notifications.push(method),
      spawnImpl: server.spawnImpl,
      platform: options?.platform ?? 'linux',
      environment: options?.environment ?? {},
      homeDirectory: options?.homeDirectory ?? homeConst,
    })
    clients.push(client)
    return client
  }

  function errorOf(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`spawn codex ${code}`)
    error.code = code
    return error
  }

  async function awaitRequest(child: FakeCodexAppServerChild, method: string): Promise<void> {
    await vi.waitFor(() => expect(child.requestOf(method)).toBeDefined())
  }

  it('handshakes, asks once and answers what the server said', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })

    expect(await clientOf(server).readRateLimits())
      .toEqual({ ok: true, result: CodexRateLimitFixtures.liveResult() })
    expect(server.child.requests.map((request) => request.method))
      .toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
    expect(server.child.requestOf('initialize')?.params)
      .toEqual({ clientInfo: { name: 'jamat', title: 'Jamat', version: '1.0.0' } })
  })

  it('goes through ComSpec on Windows and straight at the binary everywhere else', async () => {
    const windows = new FakeCodexAppServer({ autoAnswer: true })
    await clientOf(windows, {
      platform: 'win32',
      environment: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    }).readRateLimits()
    expect(windows.invocations[0]).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/q', '/c', 'codex', 'app-server'],
      options: {
        stdio: 'pipe',
        windowsHide: true,
        cwd: homeConst,
        env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      },
    })

    const withoutComSpec = new FakeCodexAppServer({ autoAnswer: true })
    await clientOf(withoutComSpec, { platform: 'win32' }).readRateLimits()
    expect(withoutComSpec.invocations[0]?.command).toBe('cmd.exe')

    const posix = new FakeCodexAppServer({ autoAnswer: true })
    await clientOf(posix, { platform: 'darwin' }).readRateLimits()
    expect(posix.invocations[0]?.command).toBe('codex')
    expect(posix.invocations[0]?.args).toEqual(['app-server'])
  })

  // `cmd /c codex` searches the CURRENT directory before PATH, so without one of its own the child is
  // whatever `codex.cmd` lies in the directory the client happened to be started from.
  it('starts the child in the home directory and never in the caller\'s own', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })

    await clientOf(server, { homeDirectory: '/home/somebody-else' }).readRateLimits()

    expect(server.invocations[0]?.options.cwd).toBe('/home/somebody-else')
  })

  it('hands the child an environment with no Jamat variable and no dev runtime left in it', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })

    await clientOf(server, {
      environment: {
        JAMAT_V3_CONFIG_DIR: 'Q:\\v3',
        JAMAT_CONFIG_DIR: 'Q:\\v1',
        NODE_ENV: 'development',
        NODE_PATH: 'Q:\\...\\electron-vite\\node_modules',
        npm_package_name: 'jamat-v3-client-ui',
        CODEX_HOME: 'Q:\\codex',
        PATH: '/usr/bin',
      },
    }).readRateLimits()

    // CODEX_HOME stays: it is what points the server at the account whose limits are being read.
    expect(server.invocations[0]?.options.env)
      .toEqual({ CODEX_HOME: 'Q:\\codex', PATH: '/usr/bin' })
  })

  it('keeps the process between reads, which is what keeps the notifications coming', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server)

    await client.readRateLimits()
    await client.readRateLimits()

    expect(server.invocations).toHaveLength(1)
    expect(server.child.requests.filter((request) => request.method === 'initialize'))
      .toHaveLength(1)
    expect(server.child.requests.filter((request) => request.method === 'account/rateLimits/read'))
      .toHaveLength(2)
  })

  it('hands a second caller the read already out', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server)

    const [first, second] = await Promise.all([client.readRateLimits(), client.readRateLimits()])

    expect(first).toBe(second)
    expect(server.invocations).toHaveLength(1)
    expect(server.child.requests.filter((request) => request.method === 'account/rateLimits/read'))
      .toHaveLength(1)
  })

  it('calls a missing binary not installed and does not spawn a second one after it', async () => {
    const thrown = new FakeCodexAppServer({ spawnError: errorOf('ENOENT') })
    expect(await clientOf(thrown).readRateLimits())
      .toEqual({ ok: false, code: 'not-installed', reason: 'Codex is not installed' })
    expect(thrown.invocations).toHaveLength(1)

    const emitted = new FakeCodexAppServer()
    const reading = clientOf(emitted).readRateLimits()
    emitted.child.fail(errorOf('ENOENT'))
    expect(await reading)
      .toEqual({ ok: false, code: 'not-installed', reason: 'Codex is not installed' })
    expect(emitted.invocations).toHaveLength(1)
  })

  it('reads cmd.exe reporting the miss in its own words as not installed', async () => {
    const server = new FakeCodexAppServer()
    const reading = clientOf(server, { platform: 'win32' }).readRateLimits()

    server.child.writeStderr(notRecognizedConst)
    server.child.exit(1)

    expect(await reading)
      .toEqual({ ok: false, code: 'not-installed', reason: 'Codex is not installed' })
    expect(server.invocations).toHaveLength(1)
  })

  it('separates a spawn that failed for another reason from a missing binary', async () => {
    const server = new FakeCodexAppServer({ spawnError: errorOf('EACCES') })
    const answer = await clientOf(server).readRateLimits()

    expect(answer).toMatchObject({ ok: false, code: 'failed' })
    expect(answer).toHaveProperty('reason', expect.stringContaining('EACCES'))
  })

  it('retries once through a fresh process and carries the stderr tail into the failure', async () => {
    const server = new FakeCodexAppServer()
    const reading = clientOf(server).readRateLimits()

    server.child.writeStderr('codex: the first one broke\n')
    server.child.exit(3)
    await vi.waitFor(() => expect(server.children).toHaveLength(2))
    server.child.writeStderr('codex: and so did the second\n')
    server.child.exit(4)

    expect(await reading).toEqual({
      ok: false,
      code: 'failed',
      reason: 'The Codex app-server exited (4): codex: and so did the second',
    })
  })

  // The ids are literal because they are part of the contract: the client numbers its requests from
  // 1 and keeps counting across a restarted process, so the retry's handshake is 3 and its read 4.
  it('carries a refusal from the server through as the reason', async () => {
    const server = new FakeCodexAppServer()
    const reading = clientOf(server).readRateLimits()

    server.child.answer(1, {})
    await awaitRequest(server.child, 'account/rateLimits/read')
    server.child.refuse(2, 'No account is signed in')
    await vi.waitFor(() => expect(server.children).toHaveLength(2))
    server.child.answer(3, {})
    await awaitRequest(server.child, 'account/rateLimits/read')
    server.child.refuse(4, 'Still no account is signed in')

    expect(await reading)
      .toEqual({ ok: false, code: 'failed', reason: 'Still no account is signed in' })
  })

  it('gives up on a silent server after two timed out attempts and kills what it started', async () => {
    vi.useFakeTimers()
    const server = new FakeCodexAppServer()
    const reading = clientOf(server).readRateLimits()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.invocations).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await reading).toEqual({
      ok: false,
      code: 'failed',
      reason: 'The Codex app-server timed out on initialize',
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(server.children.map((child) => child.killed)).toEqual([true, true])
  })

  it('reports a notification and never a request the server asked back', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server)
    await client.readRateLimits()

    server.child.notify('account/rateLimits/updated')
    server.child.notify('remoteControl/status/changed')
    server.child.ask(9_001, 'item/approvalRequested')
    server.child.stdout.write('not a message at all\n')

    await vi.waitFor(() => expect(notifications)
      .toEqual(['account/rateLimits/updated', 'remoteControl/status/changed']))
    expect(await client.readRateLimits()).toMatchObject({ ok: true })
  })

  it('ends the child on stop, kills what will not go, and stays stopped', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server)
    await client.readRateLimits()
    const child = server.child

    vi.useFakeTimers()
    client.stop()
    expect(child.stdin.ended).toBe(true)
    expect(child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(child.killed).toBe(true)
    expect(server.killers).toEqual([])

    client.stop()
    expect(await client.readRateLimits()).toEqual({
      ok: false,
      code: 'failed',
      reason: 'The Codex app-server client is stopped',
    })
    expect(server.invocations).toHaveLength(1)
  })

  // On win32 the handle is cmd.exe's. Killing it ends the wrapper and leaves `codex app-server`
  // running against a pipe nobody holds - the one thing stop() exists to make impossible.
  // The answer branch already reads `error: null` as JSON-RPC 1.0's success, so a server framing
  // its notifications the same way is the same server. Read as a request, the one channel that
  // tells this client anything between polls goes quiet with nothing said anywhere.
  // The class promises nothing here throws. Reading `.code` off a thrown `null` is itself a throw,
  // and it would leave `startProcess` by the one path that has no catch above it.
  it('answers rather than throwing when the spawn throws something that is not an Error', async () => {
    const client = new CodexAppServerClient({
      onNotification: (method) => notifications.push(method),
      spawnImpl: (() => { throw null }) as unknown as typeof spawn,
      platform: 'linux',
      environment: {},
      homeDirectory: homeConst,
    })
    clients.push(client)

    expect(await client.readRateLimits())
      .toEqual({ ok: false, code: 'failed', reason: 'The Codex app-server could not be started: null' })
  })

  it('reads a notification framed with a null id, the way JSON-RPC 1.0 writes one', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server)
    await client.readRateLimits()

    server.child.notifyLegacy('account/rateLimits/updated')

    await vi.waitFor(() => expect(notifications).toEqual(['account/rateLimits/updated']))
  })

  // readline buffers to the first newline and Node bounds no line, so an unterminated flood is one
  // string growing in the client's main process and then one `JSON.parse` over it.
  it('fails the child when the server writes a line past what an answer can be', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server)
    await client.readRateLimits()
    const flooded = server.child

    flooded.flood(1_048_577)

    await vi.waitFor(() => expect(flooded.stdin.ended).toBe(true))
    expect(await client.readRateLimits()).toMatchObject({ ok: true })
    expect(server.children).toHaveLength(2)
  })

  // The tail decides `not-installed` against `failed`. A process still dying while its replacement
  // is judged would answer for it, and a running Codex would be reported as missing.
  it('ignores the stderr of a child that has already been replaced', async () => {
    const server = new FakeCodexAppServer()
    const reading = clientOf(server).readRateLimits()
    const first = server.child

    first.exit(3)
    await vi.waitFor(() => expect(server.children).toHaveLength(2))
    first.writeStderr('codex: is not recognized as an internal or external command\n')
    server.child.writeStderr('codex: and so did the second\n')
    server.child.exit(4)

    expect(await reading).toEqual({
      ok: false,
      code: 'failed',
      reason: 'The Codex app-server exited (4): codex: and so did the second',
    })
  })

  it('kills the whole tree on win32 rather than the handle it is holding', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server, { platform: 'win32' })
    await client.readRateLimits()
    const child = server.child

    vi.useFakeTimers()
    client.stop()
    await vi.advanceTimersByTimeAsync(500)

    expect(child.killed).toBe(false)
    expect(server.killers).toEqual([{
      command: 'taskkill',
      args: ['/T', '/F', '/PID', String(child.pid)],
      options: { stdio: 'ignore', windowsHide: true },
    }])
  })

  // `{"id":2,"error":null}` used to reach `message.error.message` inside a `'line'` listener, where a
  // throw has no caller at all: it ends the process this library is linked into.
  it('reads an answer whose error is null as the answer, and a malformed one as a refusal', async () => {
    const nulled = new FakeCodexAppServer()
    const answered = clientOf(nulled).readRateLimits()
    nulled.child.answer(1, {})
    await awaitRequest(nulled.child, 'account/rateLimits/read')
    nulled.child.send({ id: 2, error: null, result: { rateLimits: {} } })

    expect(await answered).toEqual({ ok: true, result: { rateLimits: {} } })

    const malformed = new FakeCodexAppServer()
    const refused = clientOf(malformed).readRateLimits()
    malformed.child.answer(1, {})
    await awaitRequest(malformed.child, 'account/rateLimits/read')
    malformed.child.send({ id: 2, error: 'boom' })
    await vi.waitFor(() => expect(malformed.children).toHaveLength(2))
    malformed.child.answer(3, {})
    await awaitRequest(malformed.child, 'account/rateLimits/read')
    malformed.child.send({ id: 4, error: { code: -32_000 } })

    expect(await refused)
      .toEqual({ ok: false, code: 'failed', reason: 'The Codex app-server answered error -32000' })
  })

  it('leaves a child that has already gone alone', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const client = clientOf(server)
    await client.readRateLimits()
    const child = server.child
    child.exitCode = 0

    vi.useFakeTimers()
    client.stop()
    await vi.advanceTimersByTimeAsync(500)

    expect(child.stdin.ended).toBe(false)
    expect(child.killed).toBe(false)
  })
})
