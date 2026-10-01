import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { LaunchRecipe } from './appConfig'
import type { RuntimeChannel } from '../../lib-orchestrator/shared/configIdentity.types'
import type { AppContext } from './appContext'
import { LocalTargetControl } from './localTargetControl'

export type LauncherStatus = { state: 'ready' | 'stopped' | 'starting' | 'failed'; error?: string }

export class LauncherTarget {
  private readonly recipe: LaunchRecipe
  private readonly configDir: string
  private readonly channel: RuntimeChannel
  private readonly context: AppContext
  private readonly control: LocalTargetControl
  private pending: Promise<void> | null = null
  private failed = false
  private paused = false

  constructor(recipe: LaunchRecipe, configDir: string, channel: RuntimeChannel, control: LocalTargetControl, context: AppContext) {
    this.recipe = recipe
    this.configDir = configDir
    this.channel = channel
    this.context = context
    this.control = control
  }

  async status(): Promise<LauncherStatus> {
    try {
      if (this.pending) return { state: 'starting' }
      if (await this.control.ready()) return { state: 'ready' }
      return this.failed ? { state: 'failed', error: 'Jamat se nepodařilo spustit. Podrobnosti jsou v logu agenta na PC.' } : { state: 'stopped' }
    } catch {
      return { state: 'failed', error: 'Nelze ověřit nastavený profil Jamatu. Zkontrolujte konfiguraci agenta na PC.' }
    }
  }

  async start(): Promise<LauncherStatus> {
    if (this.paused) throw new Error('Launcher maintenance is in progress')
    if (this.pending) return { state: 'starting' }
    if (await this.control.ready()) return { state: 'ready' }
    if (this.paused) throw new Error('Launcher maintenance is in progress')
    // Concurrent requests may both finish their probe before either has claimed startup.
    if (this.pending) return { state: 'starting' }
    this.failed = false
    this.pending = this.launch().catch(error => {
      this.failed = true
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
    const recipe = this.recipe
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('JAMAT_V3_') && !key.startsWith('ELECTRON_')))
    env.JAMAT_V3_CONFIG_DIR = this.configDir
    env.JAMAT_V3_RUNTIME_CHANNEL = this.channel
    const log = openSync(this.context.logFile, 'a')
    let child: ChildProcess
    try {
      if (recipe.kind === 'executable')
        child = spawn(recipe.path, [], { cwd: dirname(recipe.path), env, detached: true, windowsHide: true, stdio: ['ignore', log, log] })
      else if (recipe.kind === 'command')
        child = spawn(recipe.command, recipe.args, { cwd: recipe.cwd, env, windowsHide: true,
          windowsVerbatimArguments: recipe.windowsVerbatimArguments, stdio: ['ignore', log, log] })
      else if (recipe.kind === 'source')
        child = spawn(process.execPath, [join(recipe.repositoryRoot, 'node_modules/tsx/dist/cli.mjs'),
          join(recipe.repositoryRoot, 'scripts/release/start-packaged-client.ts')],
        { cwd: recipe.repositoryRoot, env, windowsHide: true, stdio: ['ignore', log, log] })
      else throw new Error('Unknown launch recipe')
    } finally { closeSync(log) }
    if (recipe.kind === 'executable') {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
    } else if (recipe.kind === 'command' || recipe.kind === 'source') {
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
    } else throw new Error('Unknown launch recipe')
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (await this.control.ready()) {
        this.context.log('Registered AppClientUI answered its control API')
        return
      }
      await setTimeout(500)
    }
    throw new Error('AppClientUI did not become ready within 60 seconds')
  }
}
