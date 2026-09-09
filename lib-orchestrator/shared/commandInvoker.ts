import { spawn, type SpawnOptions } from 'node:child_process'
import { stat } from 'node:fs/promises'

import type { CommandFailure, CommandInvocation, CommandOutcome } from './commandInvoker.types'
import { ErrnoCode } from './errnoCode'
import { ErrorText } from './errorText'

export interface CommandInvokerOptions {
  spawnImpl?: typeof spawn
  timeoutMilliseconds?: number
  maxOutputBytes?: number
  /** Injected so a test can drive the win32 branch on any machine. */
  platform?: NodeJS.Platform
}

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
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
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
      /**
       * A timeout or abort answers, rather than only asking the child to stop.
       *
       * `'close'` fires when the process has exited AND every stdio pipe is closed, so a grandchild
       * that inherited stdout keeps it open after the parent is gone - on win32 `child.kill()` ends
       * the direct handle only, which is the very reason the Codex client carries its own
       * `taskkill /T`. Waiting for `'close'` as the ONLY way out left `run()` pending for the life
       * of the process, and whatever awaited it with it: `git` blocking on a credential helper,
       * `svn` waiting on an editor.
       *
       * So: kill the tree, then settle a short while later with whatever was collected. `'close'`
       * arriving first is the ordinary case and still wins - `finish` is idempotent.
       */
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        if (timeoutTimer !== null) clearTimeout(timeoutTimer)
        if (settleTimer !== null) clearTimeout(settleTimer)
        if (abortListener !== null)
          invocation.signal?.removeEventListener('abort', abortListener)
        settle({
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          failure,
        })
      }
      const stop = (reason: 'aborted' | 'timeout'): void => {
        failure ??= reason
        if (stopping) return
        stopping = true
        if (timeoutTimer !== null) clearTimeout(timeoutTimer)
        this.terminate(child)
        settleTimer = setTimeout(
          () => finish(null),
          CommandInvoker.settleAfterKillMillisecondsConst,
        )
        // Never the reason a process stays alive: the answer is already decided, and if everything
        // else has finished there is nobody left to hand it to.
        settleTimer.unref?.()
      }
      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        const room = this.maxOutputBytes - collected
        if (room <= 0) {
          failure ??= 'output-limit'
          return
        }
        if (chunk.length > room) {
          failure ??= 'output-limit'
          target.push(chunk.subarray(0, room))
          collected = this.maxOutputBytes
          return
        }
        target.push(chunk)
        collected += chunk.length
      }
      child.stdout?.on('data', collect(stdout))
      child.stderr?.on('data', collect(stderr))
      child.once('error', (error) => {
        failure ??= ErrnoCode.of(error) === 'ENOENT' ? 'command-missing' : 'spawn-failed'
        finish(null)
      })
      child.once('close', (code) => finish(code))
      timeoutTimer = setTimeout(() => stop('timeout'), this.timeoutMilliseconds)
      abortListener = () => stop('aborted')
      invocation.signal?.addEventListener('abort', abortListener, { once: true })
      if (invocation.signal?.aborted) abortListener()
    })
  }

  /**
   * The whole tree on win32, the direct handle elsewhere.
   *
   * `child.kill()` on Windows ends the process it was given and nothing it started, and a grandchild
   * holding the inherited pipes is exactly what keeps `'close'` from arriving. The same shape the
   * Codex client uses, for the same reason.
   */
  private terminate(child: ReturnType<typeof spawn>): void {
    if (this.platform !== 'win32' || child.pid === undefined) {
      child.kill()
      return
    }
    try {
      const killer = this.spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      // `'error'` is a taskkill that could not start; a non-zero `'exit'` is one that ran and was
      // refused. Either way the direct handle is what is left to try.
      killer.once('error', () => child.kill())
      killer.once('exit', (code) => { if (code !== 0) child.kill() })
      killer.unref()
    } catch {
      child.kill()
    }
  }
}
