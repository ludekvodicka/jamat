import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { shellWrapArgv } from '../../../core/platform-shell.js'
import { CodexRateLimits } from '../../../core/agents/codex/rateLimits.js'
import type { UsageWindow } from '../../../core/types/session.js'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RpcMessage {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
}

export class CodexRateLimitClient {
  private static readonly timeoutMs = 10_000
  private process: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private ready = false
  private stopped = false
  private startPromise: Promise<void> | null = null
  private readPromise: Promise<UsageWindow[]> | null = null
  private stderrTail = ''

  constructor(private readonly onChanged: () => void) {}

  readWindows(): Promise<UsageWindow[]> {
    if (this.readPromise) return this.readPromise
    const request = this.readWithRetry()
    const tracked = request.then(
      (windows) => { if (this.readPromise === tracked) this.readPromise = null; return windows },
      (error) => { if (this.readPromise === tracked) this.readPromise = null; throw error },
    )
    this.readPromise = tracked
    return tracked
  }

  stop(): void {
    this.stopped = true
    this.resetProcess(new Error('Codex rate-limit client stopped'))
  }

  private async readWithRetry(): Promise<UsageWindow[]> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureStarted()
        const result = await this.sendRequest('account/rateLimits/read', null)
        return CodexRateLimits.windowsFromResponse(result)
      } catch (error) {
        lastError = CodexRateLimitClient.toError(error)
        this.resetProcess(lastError)
      }
    }
    throw lastError ?? new Error('Codex rate-limit request failed')
  }

  private ensureStarted(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Codex rate-limit client is stopped'))
    if (this.process && this.ready) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    const start = this.startProcess()
    const tracked = start.then(
      () => { if (this.startPromise === tracked) this.startPromise = null },
      (error) => { if (this.startPromise === tracked) this.startPromise = null; throw error },
    )
    this.startPromise = tracked
    return tracked
  }

  private async startProcess(): Promise<void> {
    const wrapped = shellWrapArgv('codex', ['app-server'])
    const child = spawn(wrapped.file, wrapped.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process = child
    this.stderrTail = ''
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-2000)
    })
    child.once('error', (error) => this.failChild(child, error))
    child.once('exit', (code, signal) => {
      const detail = this.stderrTail.trim()
      this.failChild(child, new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`))
    })

    await this.sendRequest('initialize', {
      clientInfo: { name: 'jamat', title: 'Jamat', version: '1.0.0' },
    })
    if (this.process !== child) throw new Error('codex app-server closed during initialization')
    this.write({ method: 'initialized', params: {} })
    this.ready = true
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const child = this.process
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('codex app-server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex app-server timed out on ${method}`))
      }, CodexRateLimitClient.timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ method, id, params }) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(CodexRateLimitClient.toError(error))
      }
    })
  }

  private write(message: unknown): void {
    const child = this.process
    if (!child || child.stdin.destroyed) throw new Error('codex app-server stdin is closed')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: RpcMessage
    try { message = JSON.parse(line) as RpcMessage }
    catch { return }

    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message ?? `codex app-server error ${message.error.code ?? 'unknown'}`))
      else request.resolve(message.result)
      return
    }
    if (message.method === 'account/rateLimits/updated') this.onChanged()
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return
    this.resetProcess(error, false)
  }

  private resetProcess(error: Error, terminate = true): void {
    const child = this.process
    this.process = null
    this.ready = false
    this.lines?.close()
    this.lines = null
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    if (!child || !terminate || child.exitCode !== null) return
    try { child.stdin.end() } catch {}
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 500)
    killTimer.unref()
  }

  private static toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}
