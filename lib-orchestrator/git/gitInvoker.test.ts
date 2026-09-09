import type { spawn, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitInvoker } from './gitInvoker'

describe('lib-orchestrator/git/gitInvoker', () => {
  /** A directory that really is one: the invoker refuses to spawn into anything else. */
  const cwdConst = import.meta.dirname

  interface Invocation {
    command: string
    args: readonly string[]
    options: SpawnOptions
  }

  /** The pipes emit synchronously, so a test states what git said and then that it exited. */
  class FakeChild extends EventEmitter {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    killed = false

    kill(): boolean {
      this.killed = true
      return true
    }
  }

  function harness(): { invoker: GitInvoker; child: FakeChild; calls: Invocation[] } {
    const child = new FakeChild()
    const calls: Invocation[] = []
    const spawnImpl = ((command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, args, options })
      return child
    }) as unknown as typeof spawn
    return { invoker: new GitInvoker({ spawnImpl }), child, calls }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs git in the given directory and reports its output and exit code', async () => {
    const { invoker, child, calls } = harness()
    const running = invoker.run(cwdConst, ['status', '--porcelain=v1'])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    child.stdout.emit('data', Buffer.from(' M file.ts\n'))
    child.stderr.emit('data', Buffer.from('warning: something\n'))
    child.emit('close', 0)

    const outcome = await running
    expect(outcome).toEqual({
      code: 0,
      stdout: ' M file.ts\n',
      stderr: 'warning: something\n',
      failure: null,
    })
    expect(calls[0].command).toBe('git')
    expect(calls[0].args).toEqual(['status', '--porcelain=v1'])
    expect(calls[0].options.cwd).toBe(cwdConst)
  })

  // An inherited GIT_DIR points every command at another repository, which is the one failure that
  // is invisible in the output: the commands all succeed, against the wrong tree.
  it('hands the child no inherited GIT_ variable', async () => {
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = 'Q:\\somewhere-else\\.git'
    try {
      const { invoker, child, calls } = harness()
      const running = invoker.run(cwdConst, ['rev-parse', 'HEAD'])
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      child.emit('close', 0)
      await running
      const env = calls[0].options.env ?? {}
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path)
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })

  /**
   * The failure a removed worktree produces. Node reports it as `spawn git ENOENT` with `path: 'git'`
   * - indistinguishable from a machine without git - so the directory is the one thing that has to be
   * answered before the spawn, and the spawn must not happen at all.
   */
  it('reports a directory that does not exist as its own failure, and spawns nothing', async () => {
    const { invoker, calls } = harness()
    const missing = join(cwdConst, 'no-such-directory')

    const outcome = await invoker.run(missing, ['status'])
    expect(outcome.failure).toBe('cwd-missing')
    expect(outcome.code).toBe(-1)
    expect(outcome.stderr).toContain(missing)
    expect(calls).toEqual([])
  })

  it('reports a file handed in as a directory the same way', async () => {
    const { invoker, calls } = harness()

    expect((await invoker.run(import.meta.filename, ['status'])).failure).toBe('cwd-missing')
    expect(calls).toEqual([])
  })

  it('reports a git that is not on PATH instead of rejecting', async () => {
    const { invoker, child, calls } = harness()
    const running = invoker.run(cwdConst, ['status'])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const error: NodeJS.ErrnoException = new Error('spawn git ENOENT')
    error.code = 'ENOENT'
    child.emit('error', error)
    child.emit('close', null)

    const outcome = await running
    expect(outcome.failure).toBe('git-missing')
    expect(outcome.code).toBe(-1)
  })

  it('reports any other spawn failure as spawn-failed', async () => {
    const { invoker, child, calls } = harness()
    const running = invoker.run(cwdConst, ['status'])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const error: NodeJS.ErrnoException = new Error('spawn git EACCES')
    error.code = 'EACCES'
    child.emit('error', error)

    expect((await running).failure).toBe('spawn-failed')
  })

  it('maps a shared aborted outcome to spawn-failed', () => {
    const failureOf = Reflect.get(GitInvoker, 'failureOf')

    expect(Reflect.apply(failureOf, GitInvoker, ['aborted'])).toBe('spawn-failed')
  })

  it('kills a git that runs past the timeout and reports it', async () => {
    vi.useFakeTimers()
    const { invoker, child, calls } = harness()
    const running = invoker.run(cwdConst, ['fetch'])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(child.killed).toBe(true)
    child.emit('close', null)

    expect((await running).failure).toBe('timeout')
  })

  it('caps the output it keeps and says that it did', async () => {
    const { invoker, child, calls } = harness()
    const running = invoker.run(cwdConst, ['log'])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    child.stdout.emit('data', Buffer.alloc(8 * 1_048_576 + 10, 0x61))
    child.stdout.emit('data', Buffer.from('and more'))
    child.emit('close', 0)

    const outcome = await running
    expect(outcome.failure).toBe('output-limit')
    expect(outcome.stdout.length).toBe(8 * 1_048_576)
  })
})
