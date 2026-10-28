import { spawn, type SpawnOptions } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

import type { CommandFailure, CommandInvocation, CommandOutcome } from './commandInvoker.types'
import { ErrnoCode } from './errnoCode'
import { ErrorText } from './errorText'
import { ChildProcessLifetime } from './childProcessLifetime'

export interface CommandInvokerOptions {
  spawnImpl?: typeof spawn
  timeoutMilliseconds?: number
  maxOutputBytes?: number
  /** Injected so a test can drive the win32 branch on any machine. */
  platform?: NodeJS.Platform
}

export type InteractiveCommandResult =
  | { ok: true; closed: Promise<void> }
  | { ok: false; detail: string }

export class CommandInvoker {
  private static readonly timeoutMillisecondsConst = 10 * 60_000
  private static readonly maxOutputBytesConst = 8 * 1_048_576

  /** How long a killed child is given to close its pipes before the answer goes out without it. */
  private static readonly settleAfterKillMillisecondsConst = 2_000

  private readonly spawnImpl: typeof spawn
  private readonly timeoutMilliseconds: number
  private readonly maxOutputBytes: number
  private readonly platform: NodeJS.Platform

  constructor(options?: CommandInvokerOptions) {
    this.spawnImpl = options?.spawnImpl ?? spawn
    this.timeoutMilliseconds = options?.timeoutMilliseconds
      ?? CommandInvoker.timeoutMillisecondsConst
    this.maxOutputBytes = options?.maxOutputBytes ?? CommandInvoker.maxOutputBytesConst
    this.platform = options?.platform ?? process.platform
  }

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    if (typeof invocation.retain === 'object' && (!Number.isSafeInteger(invocation.retain.tailBytes) || invocation.retain.tailBytes < 0))
      throw new RangeError('tailBytes must be a nonnegative safe integer')
    if (invocation.timeoutMs !== undefined && (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs <= 0))
      throw new RangeError('timeoutMs must be positive')
    if (invocation.signal?.aborted) return CommandInvoker.abortedOutcome()
    if (!await CommandInvoker.isDirectory(invocation.cwd))
      return {
        code: -1,
        stdout: '',
        stderr: `${invocation.cwd} is not a directory`,
        failure: 'cwd-missing',
      }
    if (invocation.signal?.aborted) return CommandInvoker.abortedOutcome()
    return this.spawn(invocation)
  }

  async launchInteractive(invocation: Omit<CommandInvocation, 'signal'>): Promise<InteractiveCommandResult> {
    if (!await CommandInvoker.isDirectory(invocation.cwd))
      return { ok: false, detail: `${invocation.cwd} is not a directory` }
    return new Promise((resolve) => {
      let finish: () => void = () => {}
      const closed = new Promise<void>((settle) => { finish = settle })
      try {
        const child = this.spawnImpl(invocation.command, invocation.args, {
          cwd: invocation.cwd, env: invocation.env, windowsHide: true, stdio: 'ignore',
        })
        child.once('error', (error) => { finish(); resolve({ ok: false, detail: ErrorText.of(error) }) })
        child.once('close', finish)
        // An editor belongs to the person: no command timeout and no app-exit dependency.
        child.once('spawn', () => { child.unref(); resolve({ ok: true, closed }) })
      } catch (error) { finish(); resolve({ ok: false, detail: ErrorText.of(error) }) }
    })
  }

  private static abortedOutcome(): CommandOutcome {
    return { code: -1, stdout: '', stderr: '', failure: 'aborted' }
  }

  private static async isDirectory(path: string): Promise<boolean> {
    try { return (await stat(path)).isDirectory() }
    catch { return false }
  }

  private spawn(invocation: CommandInvocation): Promise<CommandOutcome> {
    return new Promise<CommandOutcome>((settle) => {
      if (invocation.signal?.aborted) {
        settle(CommandInvoker.abortedOutcome())
        return
      }
      const chunks: { stream: 'stdout' | 'stderr'; data: Buffer }[] = []
      const decoder = new StringDecoder('utf8')
      const errorDecoder = new StringDecoder('utf8')
      let collected = 0
      let failure: CommandFailure | null = null
      let settled = false
      let stopping = false
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let abortListener: (() => void) | null = null
      const options: SpawnOptions = {
        cwd: invocation.cwd,
        env: invocation.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
      let child: ReturnType<typeof spawn>
      try { child = this.spawnImpl(invocation.command, invocation.args, options) }
      catch (error) {
        settle({
          code: -1,
          stdout: '',
          stderr: ErrorText.of(error),
          failure: ErrnoCode.of(error) === 'ENOENT' ? 'command-missing' : 'spawn-failed',
        })
        return
      }
      const lifetime = new ChildProcessLifetime(child, this.spawnImpl, this.platform)
      /**
       * A timeout or abort answers, rather than only asking the child to stop.
       *
       * `'close'` fires when the process has exited AND every stdio pipe is closed, so a grandchild
       * that inherited stdout keeps it open after the parent is gone - on win32 `child.kill()` ends
       * the direct handle only, which is why the shared lifetime uses `taskkill /T`.
       * Waiting for `'close'` as the ONLY way out left `run()` pending for the life
       * of the process, and whatever awaited it with it: `git` blocking on a credential helper,
       * `svn` waiting on an editor.
       *
       * So: kill the tree, then settle a short while later with whatever was collected. `'close'`
       * arriving first is the ordinary case and still wins - `finish` is idempotent.
       */
      const finish = (code: number | null, closed = false): void => {
        if (settled) return
        settled = true
        const tail = decoder.end()
        if (tail) CommandInvoker.reportStdout(invocation, tail)
        const errorTail = errorDecoder.end()
        if (errorTail) CommandInvoker.reportStderr(invocation, errorTail)
        if (timeoutTimer !== null) clearTimeout(timeoutTimer)
        if (settleTimer !== null) clearTimeout(settleTimer)
        if (abortListener !== null)
          invocation.signal?.removeEventListener('abort', abortListener)
        const stdout = Buffer.concat(chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data))
        settle({
          code: code ?? -1,
          stdout: stdout.toString('utf8'),
          ...(invocation.stdoutBytes === true ? { stdoutBytes: stdout } : {}),
          stderr: Buffer.concat(chunks.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.data)).toString('utf8'),
          failure,
          ...(invocation.trackClose === true ? { closed } : {}),
        })
      }
      const stop = (reason: 'aborted' | 'timeout'): void => {
        failure ??= reason
        if (stopping) return
        stopping = true
        if (timeoutTimer !== null) clearTimeout(timeoutTimer)
        lifetime.terminate()
        settleTimer = setTimeout(
          () => finish(null),
          CommandInvoker.settleAfterKillMillisecondsConst,
        )
        // Never the reason a process stays alive: the answer is already decided, and if everything
        // else has finished there is nobody left to hand it to.
        settleTimer.unref?.()
      }
      const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
        if (settled) return
        const room = invocation.retain === undefined ? this.maxOutputBytes - collected : chunk.length
        if (room <= 0 && invocation.retain === undefined) {
          failure ??= 'output-limit'
          return
        }
        if (chunk.length > room) failure ??= 'output-limit'
        const accepted = chunk.subarray(0, room)
        chunks.push({ stream, data: accepted })
        collected += accepted.length
        if (typeof invocation.retain === 'object')
          while (collected > invocation.retain.tailBytes) {
            const first = chunks[0]
            const removed = Math.min(first.data.length, collected - invocation.retain.tailBytes)
            first.data = first.data.subarray(removed)
            collected -= removed
            if (first.data.length === 0) chunks.shift()
          }
        if (stream === 'stdout') {
          const text = decoder.write(accepted)
          if (text) CommandInvoker.reportStdout(invocation, text)
        } else if (stream === 'stderr') {
          const text = errorDecoder.write(accepted)
          if (text) CommandInvoker.reportStderr(invocation, text)
        } else throw new Error(`Unknown stream: ${stream}`)
      }
      child.stdout?.on('data', collect('stdout'))
      child.stderr?.on('data', collect('stderr'))
      child.once('error', (error) => {
        failure ??= ErrnoCode.of(error) === 'ENOENT' ? 'command-missing' : 'spawn-failed'
        lifetime.terminate()
        finish(null, child.pid === undefined)
      })
      child.once('close', (code) => finish(code, true))
      child.once('spawn', () => {
        try { if (child.pid !== undefined) invocation.onSpawn?.(child.pid) }
        catch (error) {
          failure = 'spawn-failed'
          chunks.push({ stream: 'stderr', data: Buffer.from(`Process identity could not be retained: ${ErrorText.of(error)}`) })
          stop('aborted')
        }
      })
      timeoutTimer = setTimeout(() => stop('timeout'), invocation.timeoutMs ?? this.timeoutMilliseconds)
      abortListener = () => stop('aborted')
      invocation.signal?.addEventListener('abort', abortListener, { once: true })
      if (invocation.signal?.aborted) abortListener()
      try { invocation.onLifetime?.(lifetime.exited) }
      catch { failure = 'spawn-failed'; stop('aborted') }
    })
  }

  private static reportStdout(invocation: CommandInvocation, text: string): void {
    // An observer cannot interrupt a VCS write or prevent its actual result from being returned.
    try { invocation.onStdout?.(text) }
    catch {}
  }

  private static reportStderr(invocation: CommandInvocation, text: string): void {
    try { invocation.onStderr?.(text) }
    catch {}
  }
}
