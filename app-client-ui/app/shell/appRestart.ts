import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'

import { ErrorText } from '../../shared/errorText'

export interface AppRestartDeps {
  /** electron-vite's renderer address: present = this client was started by the dev pipeline. */
  devRendererUrl: string | undefined
  /** The app-client-ui package directory, which is where the dev pipeline starts. */
  packageDir: string
  /** Where the respawned pipeline writes; truncated on every restart. */
  logFile: string
  report: (message: string) => void
  relaunch: () => void
  quit: () => void
  /** The tests script every restart through these; nothing in production passes them. */
  spawnImpl?: typeof spawn
  graceMilliseconds?: number
}

/**
 * Debug → Restart App: end this client and start a new one with the same parameters. Which way
 * depends on how this one was started, and `devRendererUrl` is the discriminant.
 *
 * Under the dev pipeline Electron's own `relaunch` cannot work: `electron-vite dev` builds the main
 * bundle once at startup and exits - vite server included - the moment its Electron child does, so
 * a relaunched process would run the stale bundle against a dead dev server. The restart therefore
 * spawns a fresh pipeline, whose startup build is what picks the changed code up.
 *
 * The pipeline root is `node` running electron-vite's bin directly, and both alternatives were
 * tried and measured out:
 * - `pnpm run dev` through cmd: with a detached, console-less parent, every console-subsystem
 *   process in the cmd→pnpm→node chain allocates a visible console window of its own, one more set
 *   per restart. Detached node itself gets no console, and the pipeline's own console children
 *   (esbuild services, the rate monitor's Codex shell) already hide theirs.
 * - this executable as Node (the Host-launch trick): rollup's native addon then loads ~3 s slowly
 *   and rings the Windows hard-error chime on every restart - Electron-as-Node does not suppress
 *   the LoadLibrary error beep the way plain node does.
 *
 * The environment is inherited whole, which carries the JAMAT_V3_* overrides and ELECTRON_CLI_ARGS
 * - the app's own arguments - into the new pipeline; the new electron-vite writes its own
 * ELECTRON_RENDERER_URL over the stale one.
 *
 * Anywhere else the running bundle is the newest one there is, and `relaunch` repeats this
 * process's argv and environment exactly.
 *
 * Both ways end through `quit`, so `before-quit` detaches from the Host as on any quit - every PTY
 * is the Host's and survives. The grace wait covers the one failure a detached spawn hides: a
 * pipeline that dies on the spot (no node on PATH, wrong cwd) must leave this client alive to say
 * so, instead of quitting into nothing.
 */
export class AppRestart {
  private static readonly electronViteBinConst =
    join('node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  private static readonly graceMillisecondsConst = 1_000

  constructor(private readonly deps: AppRestartDeps) {}

  async restart(): Promise<void> {
    if (this.deps.devRendererUrl !== undefined)
      await this.restartDevPipeline()
    else {
      this.deps.relaunch()
      this.deps.quit()
    }
  }

  private async restartDevPipeline(): Promise<void> {
    const child = this.spawnPipeline()
    if (child === null) return
    const evidence: { failed: string | null } = { failed: null }
    child.once('error', (error) => { evidence.failed = ErrorText.of(error) })
    // Any exit inside the grace is a failure: a pipeline that started is still building.
    child.once('exit', (code, signal) => {
      evidence.failed = signal !== null ? `exited on ${signal}` : `exited with code ${code}`
    })
    // The pipeline has to outlive the client it replaces.
    child.unref()
    await AppRestart.delay(this.deps.graceMilliseconds ?? AppRestart.graceMillisecondsConst)
    if (evidence.failed !== null) {
      this.deps.report(
        `Restart failed: the dev pipeline ${evidence.failed}; see ${this.deps.logFile}`,
      )
      return
    }
    this.deps.quit()
  }

  private spawnPipeline(): ChildProcess | null {
    let log: number
    try {
      log = openSync(this.deps.logFile, 'w')
    } catch (error) {
      this.deps.report(
        `Restart failed: cannot open ${this.deps.logFile}: ${ErrorText.of(error)}`,
      )
      return null
    }
    try {
      return (this.deps.spawnImpl ?? spawn)(
        'node',
        [join(this.deps.packageDir, AppRestart.electronViteBinConst), 'dev'],
        {
          cwd: this.deps.packageDir,
          detached: true,
          stdio: ['ignore', log, log],
          windowsHide: true,
        },
      )
    } catch (error) {
      this.deps.report(`Restart failed: ${ErrorText.of(error)}`)
      return null
    } finally {
      // The child duplicated the handle at spawn; this copy would otherwise leak one per restart.
      closeSync(log)
    }
  }

  private static delay(milliseconds: number): Promise<void> {
    return new Promise((settle) => setTimeout(settle, milliseconds))
  }
}
