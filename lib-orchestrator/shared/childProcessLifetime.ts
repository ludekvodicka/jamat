import type { ChildProcess, spawn } from 'node:child_process'

/** A bounded command result or a killed Windows wrapper does not prove that its tree ended. */
export class ChildProcessLifetime {
  readonly exited: Promise<void>
  private readonly child: ChildProcess
  private readonly spawnImpl: typeof spawn
  private readonly platform: NodeJS.Platform
  private resolveExit: () => void
  private completed: boolean
  private treeTerminationRequested: boolean

  constructor(child: ChildProcess, spawnImpl: typeof spawn, platform: NodeJS.Platform) {
    this.child = child
    this.spawnImpl = spawnImpl
    this.platform = platform
    this.completed = false
    this.treeTerminationRequested = false
    this.resolveExit = () => {}
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    const ended = (_code: number | null, signal?: NodeJS.Signals | null) => {
      if (this.platform === 'win32' && (this.treeTerminationRequested || signal != null)) return
      this.finish()
    }
    child.once('exit', ended)
    child.once('close', ended)
    child.once('error', () => { if (child.pid === undefined) this.finish() })
  }

  terminate(): void {
    if (this.completed || this.treeTerminationRequested) return
    if (this.platform !== 'win32' || this.child.pid === undefined) {
      this.killHandle()
      return
    }
    // Once tree termination starts, its failure can leave descendants alive even if the wrapper exits.
    this.treeTerminationRequested = true
    try {
      const killer = this.spawnImpl('taskkill', ['/T', '/F', '/PID', String(this.child.pid)], {
        stdio: 'ignore', windowsHide: true,
      })
      killer.once('error', () => this.killHandle())
      killer.once('exit', code => {
        if (code === 0) this.finish()
        else this.killHandle()
      })
      killer.unref()
    } catch { this.killHandle() }
  }

  private killHandle(): void {
    try { this.child.kill() } catch {}
  }

  private finish(): void {
    this.completed = true
    this.resolveExit()
  }
}
