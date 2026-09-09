import { JsonShape } from '../../shared/jsonShape'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface, type Interface } from 'node:readline'

import { ChildEnvironment } from '../../shared/childEnvironment'
import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'

/** Why a read did not answer, and the one distinction the facade acts on differently. */
export interface CodexAppServerFailure {
  /** `not-installed` becomes `unconfigured` upstream - a machine without Codex, not a broken read. */
  code: 'not-installed' | 'failed'
  reason: string
}

export type CodexAppServerAnswer =
  | { ok: true; result: unknown }
  | ({ ok: false } & CodexAppServerFailure)

export interface CodexAppServerClientDeps {
  /**
   * Every notification the server pushes, by method name and never by payload. Nothing this client
   * reads is delivered that way: a notification is a signal that the answer has moved, and the answer
   * is still asked for.
   */
  onNotification: (method: string) => void
  /** The tests script a whole app-server through this; nothing in production passes it. */
  spawnImpl?: typeof spawn
  /** Read off the running process, and injectable so a test can assert either platform's invocation. */
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  /** The directory the child is started in, injectable for the same reason as the two above. */
  homeDirectory?: string
}

interface PendingRequest {
  settle: (answer: CodexAppServerAnswer) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * `codex app-server` spoken to over its stdio, as one long-lived child this class owns.
 *
 * The child is lazy and then kept: starting one costs a process and a handshake, and while it is up
 * the server pushes `account/rateLimits/updated` whenever the numbers move, which is the only reason
 * a rate monitor learns anything between its own polls. `stop()` is therefore not optional - a client
 * that forgets it leaves a Codex behind.
 *
 * Nothing here throws. A machine without Codex, a server that never answers and a server that answers
 * an error are all ordinary outcomes of asking, and the source above turns them into readings.
 */
export class CodexAppServerClient {
  private static readonly commandConst = 'codex'
  private static readonly argsConst: readonly string[] = ['app-server']
  private static readonly readMethodConst = 'account/rateLimits/read'
  private static readonly timeoutMillisecondsConst = 10_000
  private static readonly killDelayMillisecondsConst = 500
  private static readonly stderrTailBytesConst = 2_000
  /**
   * The one thing on this child nothing else bounds. `readline` buffers until it sees a newline and
   * Node puts no maximum on a line, so a server writing a huge frame - or, on Windows, a `.cmd`
   * shim logging instead of speaking the protocol - grows one string in the client's main process
   * and then hands it to `JSON.parse` there. A line longer than a rate-limit answer is not one.
   */
  private static readonly stdoutLineBytesConst = 1_048_576
  /** The first attempt plus the one retry through a fresh process. */
  private static readonly attemptsConst = 2
  private static readonly notInstalledReasonConst = 'Codex is not installed'
  /**
   * On Windows the wrap below means a missing `codex` is not an `ENOENT` from the spawn: cmd.exe
   * starts perfectly well and then reports the miss itself, in its own words, with exit code 1 -
   * which a Codex that crashed also has. Its message is the only signal that separates the two, and
   * it is a LOCALIZED one. A machine whose cmd speaks another language therefore reads as `failed`
   * and draws the last known windows with cmd's own sentence in the tooltip, which is still true and
   * still readable; only the "not installed" placeholder is lost.
   */
  private static readonly commandMissingPatternConst
    = /is not recognized as an internal or external command/i

  private readonly spawnImpl: typeof spawn
  private readonly platform: NodeJS.Platform
  private readonly environment: NodeJS.ProcessEnv
  private readonly homeDirectory: string
  private readonly pending = new Map<number, PendingRequest>()
  private child: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private readPromise: Promise<CodexAppServerAnswer> | null = null
  private stderrTail = Buffer.alloc(0)
  private stdoutLineBytes = 0
  private nextId = 1
  private ready = false
  private stopped = false

  constructor(private readonly deps: CodexAppServerClientDeps) {
    this.spawnImpl = deps.spawnImpl ?? spawn
    this.platform = deps.platform ?? process.platform
    this.environment = deps.environment ?? process.env
    this.homeDirectory = deps.homeDirectory ?? homedir()
  }

  /**
   * Single-flight: a second caller arriving while a read is out is handed that same read. A burst of
   * notifications is what this is for - each one says the numbers moved, and one answer covers them.
   */
  readRateLimits(): Promise<CodexAppServerAnswer> {
    if (this.readPromise !== null) return this.readPromise
    const tracked = this.readWithRetry().finally(() => {
      if (this.readPromise === tracked) this.readPromise = null
    })
    this.readPromise = tracked
    return tracked
  }

  /** Idempotent, and the only thing that ends the child. Nothing restarts a stopped client. */
  stop(): void {
    this.stopped = true
    this.reset({ code: 'failed', reason: 'The Codex app-server client was stopped' })
  }

  private async readWithRetry(): Promise<CodexAppServerAnswer> {
    let failure: CodexAppServerFailure = {
      code: 'failed',
      reason: 'The Codex app-server was never asked',
    }
    for (let attempt = 0; attempt < CodexAppServerClient.attemptsConst; attempt++) {
      const start = await this.ensureStarted()
      if (start === null) {
        const answer = await this.send(CodexAppServerClient.readMethodConst, null)
        if (answer.ok) return answer
        failure = { code: answer.code, reason: answer.reason }
      }
      else failure = start
      // The process goes with the failure. What broke is this one, and asking the same dead pipe a
      // second time is the retry that cannot work; the next attempt gets a handshake of its own.
      this.reset(failure)
      // A machine without Codex does not grow one in ten seconds, and a stopped client is not a
      // fault to retry either.
      if (failure.code === 'not-installed' || this.stopped) break
    }
    return { ok: false, ...failure }
  }

  private ensureStarted(): Promise<CodexAppServerFailure | null> {
    if (this.stopped)
      return Promise.resolve({
        code: 'failed' as const,
        reason: 'The Codex app-server client is stopped',
      })
    if (this.child !== null && this.ready) return Promise.resolve(null)
    return this.startProcess()
  }

  private async startProcess(): Promise<CodexAppServerFailure | null> {
    const invocation = this.invocation()
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnImpl(invocation.command, invocation.args, {
        stdio: 'pipe',
        windowsHide: true,
        // Never the caller's directory. `cmd /c codex` searches the CURRENT directory BEFORE PATH, so
        // whatever directory the client happens to have been started in decides which `codex.cmd`
        // runs - and a repository somebody unpacked is such a directory. This child has no project of
        // its own, so it is given the one neutral place on the machine.
        cwd: this.homeDirectory,
        // `CODEX_HOME` survives this filter and has to: it is what points the server at the account
        // whose limits are being read.
        env: ChildEnvironment.withoutJamat(this.environment),
      })
    } catch (error) {
      return CodexAppServerClient.spawnFailure(error)
    }
    this.child = child
    this.stderrTail = Buffer.alloc(0)
    this.stdoutLineBytes = 0
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    // Bytes, and only this child's. The tail decides `not-installed` against `failed`, so a dying
    // process still writing into the tail of the one that replaced it would answer for it - and
    // decoding chunk by chunk would cut a multi-byte character in half at the chunk boundary,
    // which is exactly where cmd.exe's localized sentence has to survive to be recognised.
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (this.child !== child) return
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      this.stderrTail = Buffer.concat([this.stderrTail, bytes])
        .subarray(-CodexAppServerClient.stderrTailBytesConst)
    })
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (this.child !== child) return
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      const lastNewline = bytes.lastIndexOf(0x0a)
      this.stdoutLineBytes = lastNewline === -1
        ? this.stdoutLineBytes + bytes.length
        : bytes.length - lastNewline - 1
      // `reset` and not `failChild`: this child is still RUNNING, so abandoning the handle would
      // leave it writing into a pipe nobody holds. Ending it is the point.
      if (this.stdoutLineBytes > CodexAppServerClient.stdoutLineBytesConst)
        this.reset({
          code: 'failed',
          reason: 'The Codex app-server wrote a line past what an answer can be',
        })
    })
    child.once('error', (error) => this.failChild(child, CodexAppServerClient.spawnFailure(error)))
    child.once('exit', (code, signal) => this.failChild(child, this.exitFailure(code, signal)))
    const handshake = await this.send('initialize', {
      clientInfo: { name: 'jamat', title: 'Jamat', version: '1.0.0' },
    })
    if (!handshake.ok) return { code: handshake.code, reason: handshake.reason }
    // The handshake is the one await long enough for the child to have died and been replaced
    // underneath it; declaring THAT child ready would arm a process nobody is holding.
    if (this.child !== child)
      return { code: 'failed', reason: 'The Codex app-server closed while it was starting' }
    const written = this.write({ method: 'initialized', params: {} })
    if (written !== null) return written
    this.ready = true
    return null
  }

  /**
   * Windows is why this exists: `codex` installs as a `.cmd` shim there, which no spawn can execute
   * directly, so it goes through ComSpec exactly as `LaunchPlanner` puts an agent through it. On
   * every other platform the binary is the binary and a shell in between would only swallow the
   * `ENOENT` that says it is missing.
   */
  private invocation(): { command: string; args: readonly string[] } {
    if (this.platform === 'win32')
      return {
        command: this.environment.ComSpec ?? 'cmd.exe',
        args: ['/d', '/q', '/c', CodexAppServerClient.commandConst, ...CodexAppServerClient.argsConst],
      }
    return { command: CodexAppServerClient.commandConst, args: CodexAppServerClient.argsConst }
  }

  private send(method: string, params: unknown): Promise<CodexAppServerAnswer> {
    const id = this.nextId++
    return new Promise<CodexAppServerAnswer>((settle) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        settle({
          ok: false,
          code: 'failed',
          reason: `The Codex app-server timed out on ${method}`,
        })
      }, CodexAppServerClient.timeoutMillisecondsConst)
      timer.unref()
      // Registered before the write, because a fake - and a real server on a fast pipe - can answer
      // inside it.
      this.pending.set(id, { settle, timer })
      const failure = this.write({ method, id, params })
      if (failure === null) return
      clearTimeout(timer)
      this.pending.delete(id)
      settle({ ok: false, ...failure })
    })
  }

  private write(message: unknown): CodexAppServerFailure | null {
    const child = this.child
    if (child === null || child.stdin.destroyed)
      return { code: 'failed', reason: 'The Codex app-server is not running' }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
      return null
    } catch (error) {
      return { code: 'failed', reason: ErrorText.of(error) }
    }
  }

  /**
   * A line off the child is data and never a type, so every field is narrowed out of `unknown` the
   * way `CodexRateLimitMapping` reads the result. This runs inside a `'line'` listener, where a throw
   * has no caller at all: it becomes an uncaught exception and ends the process this library is
   * linked into, on the say-so of whatever answered.
   */
  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // The server is free to write a line that is not a message; one this client cannot read is
      // not a failure of the read it is waiting for.
      return
    }
    const message = JsonShape.record(parsed)
    if (message === null) return
    const method = message.method
    if (typeof method === 'string') {
      // A method means the server is talking rather than answering. With an id it is a REQUEST, and
      // this client answers none: reading its id as an answer's would settle somebody else's read
      // with the server's own question.
      // `id: null` is how JSON-RPC 1.0 writes a notification, and the answer branch below already
      // reads `error: null` as that dialect's success. Both of the server's conventions or neither.
      if (message.id === undefined || message.id === null) this.deps.onNotification(method)
      return
    }
    const id = message.id
    if (typeof id !== 'number') return
    const request = this.pending.get(id)
    if (request === undefined) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    // `error: null` is an ANSWER, not a refusal: JSON-RPC 1.0 spells every success that way, and the
    // server is free to. Only something actually there is read as the error it claims to be.
    const error = message.error
    if (error === undefined || error === null) request.settle({ ok: true, result: message.result })
    else
      request.settle({ ok: false, code: 'failed', reason: CodexAppServerClient.errorReasonOf(error) })
  }

  private static errorReasonOf(error: unknown): string {
    const record = JsonShape.record(error)
    const message = record?.message
    if (typeof message === 'string' && message.length > 0) return message
    const code = record?.code
    return `The Codex app-server answered error ${typeof code === 'number' ? code : 'unknown'}`
  }

  private failChild(child: ChildProcessWithoutNullStreams, failure: CodexAppServerFailure): void {
    if (this.child === child) this.reset(failure, false)
  }

  private reset(failure: CodexAppServerFailure, terminate = true): void {
    const child = this.child
    this.child = null
    this.ready = false
    this.lines?.close()
    this.lines = null
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.settle({ ok: false, ...failure })
    }
    this.pending.clear()
    if (child === null || !terminate || child.exitCode !== null) return
    try {
      // Ending stdin is what actually stops it: the server reads until EOF and exits on its own,
      // measured against codex-cli 0.146.0. The kill below is the fallback for one that does not.
      child.stdin.end()
    } catch {
      // A pipe already gone is the outcome this wanted anyway.
    }
    // Held, not unref'd. An unref'd timer only fires while something else keeps the loop alive, and
    // shutdown - a child that ignores EOF outliving the client that spawned it - is the one path
    // this fallback exists for and the one where nothing else does. The exit clears it instead.
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) this.terminate(child)
    }, CodexAppServerClient.killDelayMillisecondsConst)
    child.once('exit', () => clearTimeout(killTimer))
  }

  /**
   * On win32 the handle this class holds is cmd.exe's, not the server's: `child.kill()` ends the
   * wrapper and leaves `codex app-server` running against a pipe nobody holds, untracked and past the
   * one guarantee `stop()` makes. Only the TREE is the child that was started, and `taskkill /T` is
   * what ends one. Everywhere else the handle IS the process.
   *
   * This runs inside a timer callback, where nothing catches: both a taskkill that cannot be started
   * and one that fails asynchronously fall back to the handle rather than out of the event loop.
   */
  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (this.platform !== 'win32' || child.pid === undefined) {
      child.kill()
      return
    }
    try {
      const killer = this.spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      // Both halves of what the comment promises: `'error'` is a taskkill that could not be
      // started, `'exit'` with a code is one that ran and was refused - an elevated target, a
      // security hook. Either way the handle is what is left.
      killer.once('error', () => child.kill())
      killer.once('exit', (code) => { if (code !== 0) child.kill() })
      killer.unref()
    } catch {
      child.kill()
    }
  }

  private exitFailure(code: number | null, signal: NodeJS.Signals | null): CodexAppServerFailure {
    const detail = this.stderrTail.toString('utf8').trim()
    if (CodexAppServerClient.commandMissingPatternConst.test(detail))
      return { code: 'not-installed', reason: CodexAppServerClient.notInstalledReasonConst }
    return {
      code: 'failed',
      reason: `The Codex app-server exited (${code ?? signal ?? 'unknown'})`
        + `${detail === '' ? '' : `: ${detail}`}`,
    }
  }

  private static spawnFailure(error: unknown): CodexAppServerFailure {
    if (ErrnoCode.of(error) === 'ENOENT')
      return { code: 'not-installed', reason: CodexAppServerClient.notInstalledReasonConst }
    return {
      code: 'failed',
      reason: `The Codex app-server could not be started: ${ErrorText.of(error)}`,
    }
  }
}
