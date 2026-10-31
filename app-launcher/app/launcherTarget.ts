import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { inspectLauncherProcess, type RemoteLauncherProcess } from '../../lib-orchestrator/remoteControl/remoteLauncherProcess'
import type { RuntimeChannel } from '../../lib-orchestrator/shared/configIdentity.types'
import type { AppContext } from './appContext'
import type { LocalTargetControl } from './localTargetControl'

export type LauncherStatus = { state: 'ready' | 'stopped' | 'starting' | 'failed'; error?: string }

export class LauncherTarget {
  private readonly process: RemoteLauncherProcess
  private readonly configDir: string
  private readonly channel: RuntimeChannel
  private readonly context: AppContext
  private readonly control: LocalTargetControl
  private pending: Promise<void> | null = null
  private failure: string | null = null
  private activeChild: ChildProcess | null = null
  private paused = false

  constructor(process: RemoteLauncherProcess, configDir: string, channel: RuntimeChannel, control: LocalTargetControl, context: AppContext) {
    this.process = process
    this.configDir = configDir
    this.channel = channel
    this.context = context
    this.control = control
  }

  async status(): Promise<LauncherStatus> {
    try {
      if (this.pending) return { state: 'starting' }
      if (await this.control.ready()) return { state: 'ready' }
      const availability = await inspectLauncherProcess(this.process)
      if (availability.state !== 'available')
        return { state: 'failed', error: availability.state === 'missing' ? 'target-missing' : 'target-invalid' }
      return this.failure ? { state: 'failed', error: this.failure } : { state: 'stopped' }
    } catch {
      return { state: 'failed', error: 'profile-unavailable' }
    }
  }

  async start(): Promise<LauncherStatus> {
    if (this.paused) throw new Error('Launcher maintenance is in progress')
    if (this.pending) return { state: 'starting' }
    if (await this.control.ready()) return { state: 'ready' }
    if (this.paused) throw new Error('Launcher maintenance is in progress')
    // Concurrent requests may both finish their probe before either has claimed startup.
    if (this.pending) return { state: 'starting' }
    // A timed-out detached process may still become ready. Never launch a second copy beside it.
    if (this.activeChild) throw new Error('The previous launch process is still running')
    this.failure = null
    this.pending = this.launch().catch(error => {
      if (!this.failure) this.failure = 'launch-failed'
      try { this.context.log(`Launch failed: ${error instanceof Error ? error.message : 'unknown failure'}`) }
      catch { console.error('Launch failed; the local log could not be written.') }
    }).finally(() => { this.pending = null })
    return { state: 'starting' }
  }

  pause(): boolean {
    if (this.pending) return false
    this.paused = true
    return true
  }

  resume(): void {
    this.paused = false
  }

  private async launch(): Promise<void> {
    this.context.log('Starting registered target')
    const plan = this.process
    const availability = await inspectLauncherProcess(plan)
    if (availability.state !== 'available') {
      this.failure = availability.state === 'missing' ? 'target-missing' : 'target-invalid'
      throw new Error(`${this.failure}: ${availability.path}`)
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('JAMAT_V3_') && !key.startsWith('ELECTRON_')))
    env.JAMAT_V3_CONFIG_DIR = this.configDir
    env.JAMAT_V3_RUNTIME_CHANNEL = this.channel
    const log = openSync(this.context.logFile, 'a')
    let child: ChildProcess
    try {
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, env, detached: plan.completion === 'spawn',
        windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments, stdio: ['ignore', log, log] })
    } finally { closeSync(log) }
    let exited = false
    if (plan.requireRunning) {
      this.activeChild = child
      const ended = (): void => {
        exited = true
        if (this.activeChild === child) this.activeChild = null
      }
      child.once('exit', ended)
      child.once('error', ended)
    }
    if (plan.completion === 'spawn') {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
    } else if (plan.completion === 'exit-zero') {
      await new Promise<void>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
          if (process.platform === 'win32' && child.pid)
            spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
          else child.kill('SIGTERM')
          reject(new Error('Launch command timed out after 15 minutes'))
        }, 900_000)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', code => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`Launch command exited with ${String(code)}`))
        })
      })
    } else throw new Error('Unknown process completion policy')
    const deadline = Date.now() + plan.readinessTimeoutMs
    while (Date.now() < deadline) {
      if (exited) throw new Error('Launch process exited before readiness')
      if (await this.control.ready()) {
        this.context.log('Registered AppClientUI answered its control API')
        return
      }
      await setTimeout(500)
    }
    this.failure = 'readiness-timeout'
    throw new Error(`AppClientUI did not become ready within ${plan.readinessTimeoutMs / 1000} seconds`)
  }
}
