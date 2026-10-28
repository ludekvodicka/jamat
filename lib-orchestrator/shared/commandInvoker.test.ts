import type { spawn, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandInvoker } from './commandInvoker'

describe('lib-orchestrator/shared/commandInvoker', () => {
  class FakeChild extends EventEmitter {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    readonly pid = 4242
    killed = false
    killCalls = 0

    kill(): boolean {
      this.killed = true
      this.killCalls += 1
      return true
    }

    unref(): void {}
  }

  afterEach(() => vi.useRealTimers())

  it.each([true, false])('distinguishes a proved child close from the post-kill timer: close=%s', async (closes) => {
    vi.useFakeTimers()
    const child = new FakeChild(), spawnImpl = vi.fn(() => child) as unknown as typeof spawn
    const running = new CommandInvoker({ spawnImpl, timeoutMilliseconds: 50, platform: 'linux' })
      .run({ command: 'tool', args: [], cwd: import.meta.dirname, env: {}, trackClose: true })
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(50)
    if (closes) child.emit('close', null)
    else await vi.advanceTimersByTimeAsync(2_000)
    expect(await running).toMatchObject({ failure: 'timeout', closed: closes })
  })

  it('returns an interactive launch before close, without timing out the editor', async () => {
    const child = new FakeChild()
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn
    const started = new CommandInvoker({ spawnImpl, timeoutMilliseconds: 1 }).launchInteractive({ command: 'editor', args: ['two words'], cwd: import.meta.dirname, env: {} })
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.emit('spawn')
    const result = await started
    expect(result.ok).toBe(true)
    expect(spawnImpl).toHaveBeenCalledWith('editor', ['two words'], expect.objectContaining({ stdio: 'ignore', windowsHide: true }))
    let closed = false
    if (!result.ok) throw new Error(result.detail)
    void result.closed.then(() => { closed = true })
    expect(closed).toBe(false)
    expect(child.killed).toBe(false)
    child.emit('close', 0)
    await result.closed
    expect(closed).toBe(true)
  })

  it('runs a command with the exact invocation and captures both streams', async () => {
    const child = new FakeChild()
    const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = []
    const spawnImpl = ((command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, args, options })
      return child
    }) as unknown as typeof spawn
    const invoker = new CommandInvoker({ spawnImpl })
    const env = { TEST_COMMAND_INVOKER: 'yes' }
    const running = invoker.run({ command: 'tool', args: ['one'], cwd: import.meta.dirname, env })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    child.stdout.emit('data', Buffer.from('out'))
    child.stderr.emit('data', Buffer.from('err'))
    child.emit('close', 3)

    expect(await running).toEqual({ code: 3, stdout: 'out', stderr: 'err', failure: null })
    expect(calls[0]).toEqual({
      command: 'tool',
      args: ['one'],
      options: expect.objectContaining({ cwd: import.meta.dirname, env }),
    })
  })

  it('answers the raw stdout bytes only to a run that asks, so a binary file survives the UTF-8 decoding', async () => {
    const bytes = Buffer.from([0x89, 0x00, 0xff, 0xfe])
    const outcomeOf = async (stdoutBytes: boolean) => {
      const child = new FakeChild()
      const spawnImpl = (() => child) as unknown as typeof spawn
      const running = new CommandInvoker({ spawnImpl })
        .run({ command: 'tool', args: [], cwd: import.meta.dirname, env: {}, ...stdoutBytes ? { stdoutBytes: true as const } : {} })
      await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0))
      child.stdout.emit('data', bytes.subarray(0, 2))
      child.stdout.emit('data', bytes.subarray(2))
      child.emit('close', 0)
      return running
    }

    expect((await outcomeOf(true)).stdoutBytes).toEqual(bytes)
    expect(await outcomeOf(false)).not.toHaveProperty('stdoutBytes')
  })

  it('does not spawn a command whose signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawnImpl = vi.fn(() => { throw new Error('unexpected spawn') }) as unknown as typeof spawn

    const outcome = await new CommandInvoker({ spawnImpl }).run({
      command: 'tool',
      args: [],
      cwd: import.meta.dirname,
      env: {},
      signal: controller.signal,
    })

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(outcome).toEqual({ code: -1, stdout: '', stderr: '', failure: 'aborted' })
  })

  it('streams bounded UTF-8 stdout before close, preserving the final output and ignoring late chunks', async () => {
    const child = new FakeChild()
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn
    const onStdout = vi.fn()
    const running = new CommandInvoker({ spawnImpl, maxOutputBytes: 6 }).run({
      command: 'tool', args: [], cwd: import.meta.dirname, env: {}, onStdout,
    })
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    const data = Buffer.from('žluť')
    child.stdout.emit('data', data.subarray(0, 1))
    expect(onStdout).not.toHaveBeenCalled()
    child.stdout.emit('data', data.subarray(1))
    expect(onStdout).toHaveBeenCalledWith('žluť')
    child.stdout.emit('data', Buffer.from('overflow'))
    child.emit('close', 0)
    expect(await running).toEqual({ code: 0, stdout: 'žluť', stderr: '', failure: 'output-limit' })
    child.stdout.emit('data', Buffer.from('late'))
    expect(onStdout).toHaveBeenCalledTimes(1)
  })

  it('streams twenty MiB while retaining only the combined tail', async () => {
    const child = new FakeChild()
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn
    let streamed = 0
    const running = new CommandInvoker({ spawnImpl }).run({ command: 'tool', args: [], cwd: import.meta.dirname, env: {},
      retain: { tailBytes: 32 }, onStdout: (text) => { streamed += Buffer.byteLength(text) } })
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    for (let index = 0; index < 20; index += 1) child.stdout.emit('data', Buffer.alloc(1_048_576, 'x'))
    child.stderr.emit('data', Buffer.from('done'))
    child.emit('close', 0)
    expect(streamed).toBe(20 * 1_048_576)
    expect(await running).toEqual({ code: 0, stdout: 'x'.repeat(28), stderr: 'done', failure: null })
  })

  it('honors a per-call timeout without changing the invoker default', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    let started!: () => void
    const spawned = new Promise<void>((resolve) => { started = resolve })
    const spawnImpl = (() => { started(); return child }) as unknown as typeof spawn
    const running = new CommandInvoker({ spawnImpl, platform: 'linux', timeoutMilliseconds: 1000 }).run({
      command: 'tool', args: [], cwd: import.meta.dirname, env: {}, timeoutMs: 10,
    })
    await spawned
    await vi.advanceTimersByTimeAsync(10)
    expect(child.killed).toBe(true)
    child.emit('close', null)
    expect((await running).failure).toBe('timeout')
  })

  it('preserves command completion when a progress observer throws', async () => {
    const child = new FakeChild()
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn
    const running = new CommandInvoker({ spawnImpl }).run({ command: 'tool', args: [], cwd: import.meta.dirname, env: {},
      onStdout: () => { throw new Error('observer failed') },
    })
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.emit('data', Buffer.from('Committed revision 42.'))
    child.emit('close', 0)
    expect(await running).toEqual({ code: 0, stdout: 'Committed revision 42.', stderr: '', failure: null })
  })

  it('distinguishes a missing cwd from a missing command', async () => {
    const calls: string[] = []
    const spawnImpl = (() => { calls.push('spawned'); throw new Error('unexpected') }) as unknown as typeof spawn
    const invoker = new CommandInvoker({ spawnImpl })

    const outcome = await invoker.run({
      command: 'tool',
      args: [],
      cwd: join(import.meta.dirname, 'missing'),
      env: {},
    })
    expect(outcome.failure).toBe('cwd-missing')
    expect(calls).toEqual([])
  })

  it('maps ENOENT and other asynchronous spawn errors', async () => {
    for (const [code, expected] of [['ENOENT', 'command-missing'], ['EACCES', 'spawn-failed']] as const) {
      const child = new FakeChild()
      let markSpawned!: () => void
      const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
      const spawnImpl = (() => {
        markSpawned()
        return child
      }) as unknown as typeof spawn
      const running = new CommandInvoker({ spawnImpl }).run({
        command: 'tool',
        args: [],
        cwd: import.meta.dirname,
        env: {},
      })
      await spawned
      const error: NodeJS.ErrnoException = new Error(code)
      error.code = code
      child.emit('error', error)
      expect((await running).failure).toBe(expected)
    }
  })

  /*
   * `'close'` fires when the process has exited AND every stdio pipe is closed, so a grandchild that
   * inherited stdout keeps it open after the parent is gone. Waiting for it as the ONLY way out left
   * `run()` pending for the life of the process, and whatever awaited it with it: `git` blocking on
   * a credential helper, `svn` waiting on an editor. The per-call timeout shortened the wait before
   * the hang, not the hang.
   */
  it('answers after a timeout even when the pipes never close', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    let markSpawned!: () => void
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
    const spawnImpl = (() => {
      markSpawned()
      return child
    }) as unknown as typeof spawn
    // `linux`, because what this is about is SETTLING rather than which kill is used; the two
    // kills have a test of their own below.
    const running = new CommandInvoker({ spawnImpl, timeoutMilliseconds: 50, platform: 'linux' })
      .run({ command: 'tool', args: [], cwd: import.meta.dirname, env: {} })
    await spawned
    child.stdout.emit('data', Buffer.from('half a line'))

    // The kill lands and nothing closes: the grandchild still holds the pipes.
    await vi.advanceTimersByTimeAsync(50)
    expect(child.killed).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)

    // Answered with what was collected, rather than pending for ever.
    expect(await running).toEqual({
      code: -1,
      stdout: 'half a line',
      stderr: '',
      failure: 'timeout',
    })
  })

  it('aborts a running command through win32 tree termination and settles once', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const child = new FakeChild()
    const killer = new FakeChild()
    const spawns: { command: string; args: readonly string[] }[] = []
    let markSpawned!: () => void
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
    const spawnImpl = ((command: string, args: readonly string[]) => {
      spawns.push({ command, args })
      if (command === 'taskkill') return killer
      markSpawned()
      return child
    }) as unknown as typeof spawn
    const running = new CommandInvoker({ spawnImpl, platform: 'win32' }).run({
      command: 'tool',
      args: [],
      cwd: import.meta.dirname,
      env: {},
      signal: controller.signal,
    })
    const completed = vi.fn()
    const observed = running.then((outcome) => {
      completed(outcome)
      return outcome
    })
    await spawned

    controller.abort()
    expect(spawns).toEqual([
      { command: 'tool', args: [] },
      { command: 'taskkill', args: ['/T', '/F', '/PID', String(child.pid)] },
    ])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await observed).toEqual({ code: -1, stdout: '', stderr: '', failure: 'aborted' })

    child.emit('close', 0)
    await Promise.resolve()
    expect(completed).toHaveBeenCalledTimes(1)
  })

  it('keeps the first reason when abort and timeout race', async () => {
    vi.useFakeTimers()
    for (const first of ['aborted', 'timeout'] as const) {
      const controller = new AbortController()
      const child = new FakeChild()
      let markSpawned!: () => void
      const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
      const spawnImpl = (() => {
        markSpawned()
        return child
      }) as unknown as typeof spawn
      const running = new CommandInvoker({
        spawnImpl,
        timeoutMilliseconds: 50,
        platform: 'linux',
      }).run({
        command: 'tool',
        args: [],
        cwd: import.meta.dirname,
        env: {},
        signal: controller.signal,
      })
      await spawned

      if (first === 'aborted') controller.abort()
      else if (first === 'timeout') await vi.advanceTimersByTimeAsync(50)
      else throw new Error(`Unknown first reason: ${JSON.stringify(first)}`)
      if (first === 'aborted') await vi.advanceTimersByTimeAsync(50)
      else if (first === 'timeout') controller.abort()
      else throw new Error(`Unknown first reason: ${JSON.stringify(first)}`)
      await vi.advanceTimersByTimeAsync(2_000)

      expect((await running).failure).toBe(first)
      expect(child.killCalls).toBe(1)
    }
  })

  it('removes its abort listener after completion and ignores a late abort', async () => {
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const child = new FakeChild()
    let markSpawned!: () => void
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
    const spawnImpl = (() => {
      markSpawned()
      return child
    }) as unknown as typeof spawn
    const running = new CommandInvoker({ spawnImpl, platform: 'linux' }).run({
      command: 'tool',
      args: [],
      cwd: import.meta.dirname,
      env: {},
      signal: controller.signal,
    })
    await spawned
    child.emit('close', 0)

    expect(await running).toEqual({ code: 0, stdout: '', stderr: '', failure: null })
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(child.killCalls).toBe(0)
  })

  it('kills the whole tree on win32, and the handle alone elsewhere', async () => {
    vi.useFakeTimers()
    for (const platform of ['win32', 'linux'] as const) {
      const child = new FakeChild()
      const killer = new FakeChild()
      const spawns: { command: string; args: readonly string[] }[] = []
      let markSpawned!: () => void
      const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
      const spawnImpl = ((command: string, args: readonly string[]) => {
        spawns.push({ command, args })
        if (command === 'taskkill') return killer
        markSpawned()
        return child
      }) as unknown as typeof spawn
      const running = new CommandInvoker({ spawnImpl, timeoutMilliseconds: 50, platform })
        .run({ command: 'tool', args: [], cwd: import.meta.dirname, env: {} })
      await spawned
      await vi.advanceTimersByTimeAsync(50)

      if (platform === 'win32') {
        // The tree, because `child.kill()` on Windows ends the direct handle only - which is what
        // leaves a grandchild holding the pipes `'close'` is waiting for.
        expect(spawns.map((call) => call.command), platform).toEqual(['tool', 'taskkill'])
        expect(spawns[1]?.args, platform).toEqual(['/T', '/F', '/PID', String(child.pid)])
        expect(child.killed, platform).toBe(false)
        // A taskkill that ran and was refused still leaves the handle to try.
        killer.emit('exit', 1)
        expect(child.killed, platform).toBe(true)
      }
      else {
        expect(spawns.map((call) => call.command), platform).toEqual(['tool'])
        expect(child.killed, platform).toBe(true)
      }

      await vi.advanceTimersByTimeAsync(2_000)
      expect((await running).failure, platform).toBe('timeout')
    }
  })

  it('kills a timed out command and caps combined output', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    let markSpawned!: () => void
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
    const spawnImpl = (() => {
      markSpawned()
      return child
    }) as unknown as typeof spawn
    const running = new CommandInvoker({
      spawnImpl,
      timeoutMilliseconds: 50,
      maxOutputBytes: 4,
      platform: 'linux',
    }).run({ command: 'tool', args: [], cwd: import.meta.dirname, env: {} })
    await spawned
    child.stdout.emit('data', Buffer.from('abcdef'))
    await vi.advanceTimersByTimeAsync(50)
    expect(child.killed).toBe(true)
    child.emit('close', null)

    expect(await running).toEqual({
      code: -1,
      stdout: 'abcd',
      stderr: '',
      failure: 'output-limit',
    })
  })

  it.each(['timeout', 'aborted'] as const)('keeps lifetime pending after bounded %s with zero retained output', async reason => {
    vi.useFakeTimers()
    const child = new FakeChild(), controller = new AbortController(), released = vi.fn()
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const onLifetime = vi.fn((exited: Promise<void>) => { void exited.then(released); started() })
    const running = new CommandInvoker({ spawnImpl, platform: 'linux', timeoutMilliseconds: 50 }).run({
      command: 'tool', args: [], cwd: import.meta.dirname, env: {}, signal: controller.signal,
      retain: { tailBytes: 0 }, onLifetime,
    })
    await ready
    expect(onLifetime).toHaveBeenCalledOnce()
    child.stdout.emit('data', Buffer.from('SENSITIVE_STDOUT'))
    child.stderr.emit('data', Buffer.from('SENSITIVE_STDERR'))
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(50)
    else if (reason === 'aborted') controller.abort()
    else throw new Error(`Unknown stop reason: ${reason}`)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await running).toEqual({ code: -1, stdout: '', stderr: '', failure: reason })
    expect(released).not.toHaveBeenCalled()
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toHaveBeenCalledOnce()
  })

  it.each([true, false])('accounts for spawn error lifetime when a native PID exists=%s', async hasPid => {
    const child = new FakeChild(), released = vi.fn()
    if (!hasPid) Object.defineProperty(child, 'pid', { value: undefined })
    const onLifetime = vi.fn((exited: Promise<void>) => { void exited.then(released) })
    const running = new CommandInvoker({ spawnImpl: (() => child) as unknown as typeof spawn, platform: 'linux' }).run({
      command: 'tool', args: [], cwd: import.meta.dirname, env: {}, retain: { tailBytes: 0 }, onLifetime,
    })
    await vi.waitFor(() => expect(onLifetime).toHaveBeenCalledOnce())
    child.emit('error', new Error('fixture spawn error'))
    expect(await running).toEqual({ code: -1, stdout: '', stderr: '', failure: 'spawn-failed' })
    if (hasPid) {
      expect(released).not.toHaveBeenCalled()
      expect(child.killed).toBe(true)
      child.emit('exit', 1)
      child.emit('close', 1)
      await Promise.resolve()
    }
    expect(released).toHaveBeenCalledOnce()
  })

  it.each(['aborted', 'throws'] as const)('creates no lifetime for a command that never spawns: %s', async outcome => {
    const controller = new AbortController(), onLifetime = vi.fn()
    const spawnImpl = vi.fn(() => { throw new Error('fixture refused spawn') }) as unknown as typeof spawn
    if (outcome === 'aborted') controller.abort()
    else if (outcome === 'throws') expect(controller.signal.aborted).toBe(false)
    else throw new Error(`Unknown startup outcome: ${outcome}`)
    const result = await new CommandInvoker({ spawnImpl }).run({
      command: 'tool', args: [], cwd: import.meta.dirname, env: {}, signal: controller.signal, onLifetime,
    })
    if (outcome === 'aborted') expect(result.failure).toBe('aborted')
    else if (outcome === 'throws') expect(result.failure).toBe('spawn-failed')
    else throw new Error(`Unknown startup outcome: ${outcome}`)
    expect(onLifetime).not.toHaveBeenCalled()
  })
})
