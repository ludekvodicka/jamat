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
})
