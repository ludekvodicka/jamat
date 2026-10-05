import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync, renameSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { WebSocket, WebSocketServer } from 'ws'

import type { CodexSessionCommand, CodexSessionLaunch } from '../../lib-orchestrator/sessionManager/codexSessionIdentity'
import { CodexIdentity } from './codexIdentity'
import { CodexLaunchPermissions } from './codexLaunchPermissions'

export class App {
  private readonly launch: CodexSessionLaunch
  private readonly identity: CodexIdentity
  private readonly permissions: CodexLaunchPermissions
  private readonly token = randomUUID()
  private server: WebSocketServer | null = null
  private backend: ChildProcessWithoutNullStreams | null = null
  private client: ChildProcess | null = null
  private lines: Interface | null = null
  private socket: WebSocket | null = null
  private closed = false
  private connected = false
  private finish: ((code: number) => void) | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  // Match ws's default message ceiling for the stdio direction too.
  private static readonly frameBytesConst = 100 * 1024 * 1024

  constructor(launch: CodexSessionLaunch) {
    this.launch = launch
    this.identity = new CodexIdentity(launch)
    this.permissions = new CodexLaunchPermissions(launch.yolo === true)
  }

  async run(): Promise<number> {
    const done = new Promise<number>(resolve => { this.finish = resolve })
    try {
      this.server = new WebSocketServer({host: '127.0.0.1', port: 0, maxPayload: App.frameBytesConst})
      await new Promise<void>((resolve, reject) => {
        this.server!.once('listening', resolve)
        this.server!.once('error', reject)
      })
      this.server.on('error', error => this.fail(error))
      this.server.on('connection', (socket, request) => {
        if (request.headers.authorization !== `Bearer ${this.token}` || this.connected) {
          socket.close(1008, 'Unauthorized connection')
          return
        }
        this.connected = true
        this.socket = socket
        if (this.deadline !== null) clearTimeout(this.deadline)
        socket.on('message', data => {
          try {
            const message = this.permissions.request(JSON.parse(data.toString()))
            this.identity.sent(message)
            if ((this.backend?.stdin.writableLength ?? 0) > App.frameBytesConst)
              throw new Error('Codex app-server input is not draining')
            this.backend?.stdin.write(`${JSON.stringify(message)}\n`)
          } catch (error) { this.fail(error) }
        })
        socket.on('error', error => this.fail(error))
        socket.on('close', code => {
          if (this.closed) return
          // A normal terminal exit can close its socket just before Node observes its exit.
          this.deadline = setTimeout(() => this.fail(new Error(`Codex terminal disconnected (${code})`)), 1500)
        })
      })
      const address = this.server.address()
      if (address === null || typeof address === 'string') throw new Error('No Codex bridge listener')
      const environment = {...process.env}
      delete environment.ELECTRON_RUN_AS_NODE
      delete environment.JAMAT_V3_CODEX_BRIDGE_TOKEN
      this.backend = spawn(this.launch.server.command,
        [...this.launch.server.prefixArgs, ...this.launch.server.args], {
          cwd: this.launch.cwd, env: environment, windowsHide: true, stdio: 'pipe',
        })
      this.backend.once('error', error => this.fail(error))
      this.backend.once('exit', code => {
        if (!this.closed) this.fail(new Error(`Codex app-server exited (${code ?? 'signal'})`))
      })
      this.backend.stdin.on('error', error => { if (!this.closed) this.fail(error) })
      this.backend.stderr.on('data', chunk => { if (!this.closed) process.stderr.write(chunk) })
      let lineBytes = 0
      this.backend.stdout.on('data', (chunk: Buffer) => {
        for (const part of chunk.toString('utf8').split(/(?<=\n)/)) {
          lineBytes += Buffer.byteLength(part)
          if (lineBytes > App.frameBytesConst) this.fail(new Error('Codex protocol frame exceeds 100 MiB'))
          if (part.endsWith('\n')) lineBytes = 0
        }
      })
      this.lines = createInterface({input: this.backend.stdout})
      this.lines.on('line', line => {
        if (this.closed) return
        try {
          const receipt = this.identity.received(JSON.parse(line))
          if (receipt !== null) {
            this.permissions.confirmed()
            const temporary = `${this.launch.receiptFile}.tmp`
            writeFileSync(temporary, JSON.stringify(receipt), {encoding: 'utf8', mode: 0o600})
            renameSync(temporary, this.launch.receiptFile)
          }
          if (this.socket?.readyState !== WebSocket.OPEN)
            throw new Error('Codex answered without its terminal connection')
          if (this.socket.bufferedAmount > App.frameBytesConst)
            throw new Error('Codex terminal output is not draining')
          this.socket.send(line)
        } catch (error) { this.fail(error) }
      })
      const command = this.launch.client
      this.client = spawn(command.command, [...command.prefixArgs,
        '--remote', `ws://127.0.0.1:${address.port}`,
        '--remote-auth-token-env', 'JAMAT_V3_CODEX_BRIDGE_TOKEN', ...command.args], {
        cwd: this.launch.cwd,
        env: {...environment, JAMAT_V3_CODEX_BRIDGE_TOKEN: this.token}, stdio: 'inherit',
      })
      this.client.once('error', error => this.fail(error))
      this.client.once('exit', code => this.stop(code ?? 1))
      if (!this.connected)
        this.deadline = setTimeout(() => this.fail(new Error('Codex terminal did not connect within 60 seconds')), 60_000)
    } catch (error) { this.fail(error) }
    return done
  }

  stop(code: number): void {
    if (this.closed) return
    this.closed = true
    if (this.deadline !== null) clearTimeout(this.deadline)
    this.lines?.close()
    this.socket?.terminate()
    for (const socket of this.server?.clients ?? []) socket.terminate()
    this.server?.close()
    this.backend?.stdin.end()
    const children = [this.backend, this.client].filter((child): child is ChildProcess => child !== null)
    void Promise.all(children.map(child => App.endChild(child))).then(() => this.finish?.(code))
  }

  private fail(error: unknown): void {
    if (this.closed) return
    process.stderr.write(`\nJamat cannot verify this Codex session: ${error instanceof Error ? error.message : String(error)}\n`)
    this.stop(1)
  }

  private static async endChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    await new Promise<void>(resolve => {
      const finished = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { child.off('close', finished); resolve() }, 1500)
      child.once('close', finished)
    })
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', timeout: 5000})
        killer.once('exit', () => resolve())
        killer.once('error', () => { child.kill(); resolve() })
      })
    } else child.kill('SIGTERM')
  }

  static launchOf(value: unknown): CodexSessionLaunch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex launch')
    const launch = value as CodexSessionLaunch
    if (launch.schemaVersion !== 1 || !App.pathId(launch.jamatSessionId) || !App.pathId(launch.launchId)
      || typeof launch.cwd !== 'string' || !isAbsolute(launch.cwd)
      || typeof launch.receiptFile !== 'string' || !isAbsolute(launch.receiptFile))
      throw new Error('Invalid Codex launch identity')
    if (launch.yolo !== undefined && typeof launch.yolo !== 'boolean') throw new Error('Invalid Codex launch permissions')
    if (launch.mode === 'new' || launch.mode === 'continue') {
      // Neither operation names an existing thread.
    } else if (launch.mode === 'resume') {
      if (!App.threadId(launch.nativeSessionId)) throw new Error('Invalid Codex resume identity')
    } else if (launch.mode === 'fork') {
      if (!App.threadId(launch.forkParentId)) throw new Error('Invalid Codex fork identity')
    } else throw new Error('Invalid Codex launch mode')
    App.checkCommand(launch.client)
    App.checkCommand(launch.server)
    return launch
  }

  private static checkCommand(command: CodexSessionCommand): void {
    if (!command || typeof command.command !== 'string' || command.command.length === 0 || !Array.isArray(command.prefixArgs)
      || !Array.isArray(command.args)
      || ![...command.prefixArgs, ...command.args].every(arg => typeof arg === 'string'))
      throw new Error('Invalid Codex command')
  }

  private static pathId(value: unknown): boolean {
    return typeof value === 'string' && /^[a-zA-Z0-9-]+$/.test(value)
  }

  private static threadId(value: unknown): boolean {
    return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
  }
}
