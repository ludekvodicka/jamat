import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { CodexRateLimitFixtures } from './codexRateLimitFixtures'

/**
 * A fake `codex app-server`: the child, its stdio and its framing, and the spawn that hands one out.
 *
 * Its own file rather than three quarters of `codexRateLimitFixtures.ts`, which is named after the
 * smallest of the three things that were in it. Every sibling fixture file here holds one class.
 */

/** One JSON-RPC line the client wrote, as the server reads it back. */
export interface CodexAppServerRequestLine {
  id?: number
  method?: string
  params?: unknown
}

/** The spawn options this client passes, which is all a test has to assert on. */
export interface FakeCodexSpawnOptions {
  stdio?: string
  windowsHide?: boolean
  cwd?: string
  env?: Record<string, string>
}

export interface FakeCodexSpawnCall {
  command: string
  args: readonly string[]
  options: FakeCodexSpawnOptions
}

export interface FakeCodexAppServerOptions {
  /** Answers `initialize` and the rate limit read on its own, which is what most tests want. */
  autoAnswer?: boolean
  /** What the auto-answer gives back for `account/rateLimits/read`. */
  rateLimits?: unknown
  /** Thrown by the spawn itself, which is how a missing binary arrives everywhere but Windows. */
  spawnError?: NodeJS.ErrnoException
}

/**
 * A `codex app-server` child a test drives by hand: it collects what the client wrote, and every
 * answer, notification, stderr byte and exit is something the test says explicitly.
 *
 * Its stdout is a real stream, because the line framing is part of what is under test - the client
 * reads it through `node:readline`, so a test asserting on an answer is asserting on the real path.
 */
export class FakeCodexAppServerChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new EventEmitter()
  readonly requests: CodexAppServerRequestLine[] = []
  readonly stdin = {
    destroyed: false,
    ended: false,
    write: (chunk: string): boolean => {
      this.absorb(chunk)
      return true
    },
    end: (): void => {
      this.stdin.ended = true
    },
  }

  exitCode: number | null = null
  killed = false
  unreferenced = false

  private pendingText = ''

  constructor(readonly pid: number, private readonly options: FakeCodexAppServerOptions) {
    super()
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  unref(): void {
    this.unreferenced = true
  }

  /** One JSON-RPC line, framed the way the server frames them. */
  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  answer(id: number, result: unknown): void {
    this.send({ id, result })
  }

  refuse(id: number, message: string): void {
    this.send({ id, error: { code: -32000, message } })
  }

  notify(method: string): void {
    this.send({ method, params: {} })
  }

  /** JSON-RPC 1.0 writes a notification with a null id rather than none at all. */
  notifyLegacy(method: string): void {
    this.send({ method, params: {}, id: null })
  }

  /** Bytes with no newline in them: readline holds every one of these in a single string. */
  flood(bytes: number): void {
    this.stdout.write('x'.repeat(bytes))
  }

  /** A server-to-client REQUEST: a method AND an id, which answers nothing the client asked. */
  ask(id: number, method: string): void {
    this.send({ id, method, params: {} })
  }

  writeStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text))
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
  }

  fail(error: NodeJS.ErrnoException): void {
    this.emit('error', error)
  }

  requestOf(method: string): CodexAppServerRequestLine | undefined {
    return this.requests.find((request) => request.method === method)
  }

  private absorb(chunk: string): void {
    this.pendingText += chunk
    let index = this.pendingText.indexOf('\n')
    while (index >= 0) {
      const line = this.pendingText.slice(0, index)
      this.pendingText = this.pendingText.slice(index + 1)
      if (line.length > 0) this.receive(line)
      index = this.pendingText.indexOf('\n')
    }
  }

  private receive(line: string): void {
    const request = JSON.parse(line) as CodexAppServerRequestLine
    this.requests.push(request)
    if (this.options.autoAnswer !== true || typeof request.id !== 'number') return
    if (request.method === 'initialize')
      this.answer(request.id, { userAgent: 'jamat/0.146.0', platformOs: 'windows' })
    else if (request.method === 'account/rateLimits/read')
      this.answer(request.id, this.options.rateLimits ?? CodexRateLimitFixtures.liveResult())
  }
}

/** The `spawn` the client is handed, plus every child it has produced and every invocation it saw. */
export class FakeCodexAppServer {
  /** The win32 tree kill, which is a spawn of this seam and not an app-server. */
  private static readonly killCommandConst = 'taskkill'
  private static readonly firstPidConst = 4_100

  readonly invocations: FakeCodexSpawnCall[] = []
  readonly children: FakeCodexAppServerChild[] = []
  /** Kept apart from the invocations above: nothing here is a server a test can drive. */
  readonly killers: FakeCodexSpawnCall[] = []
  readonly spawnImpl: typeof spawn

  constructor(private readonly options: FakeCodexAppServerOptions = {}) {
    this.spawnImpl = ((
      command: string,
      args: readonly string[],
      spawnOptions: FakeCodexSpawnOptions,
    ) => {
      if (command === FakeCodexAppServer.killCommandConst) {
        this.killers.push({ command, args, options: spawnOptions })
        return new FakeCodexAppServerChild(0, {})
      }
      this.invocations.push({ command, args, options: spawnOptions })
      if (this.options.spawnError !== undefined) throw this.options.spawnError
      const child = new FakeCodexAppServerChild(
        FakeCodexAppServer.firstPidConst + this.children.length,
        this.options,
      )
      this.children.push(child)
      return child
    }) as unknown as typeof spawn
  }

  /** The child of the newest spawn. */
  get child(): FakeCodexAppServerChild {
    const child = this.children.at(-1)
    if (child === undefined) throw new Error('The fake Codex app-server was never spawned')
    return child
  }
}
