/**
 * End-to-end proof that app-client-ui composes and boots: it builds the three bundles, launches the
 * real Electron binary with `--smoke`, and waits for the main process to report that the renderer
 * reported ITSELF ready - a handshake the shell sends only after the preload bridge answered and it
 * mounted. That run also creates a probe, waits for its main layout to be durable, moves it into a
 * second real renderer, checks both durable layouts and exercises default and tinted native icons.
 * Waiting for did-finish-load alone passed a boot whose preload had thrown.
 *
 * It then runs the same bundle a second time with the Host auto-start ON, because the first run
 * cannot speak for it: a Host that was never spawned and a Host whose spawn failed leave exactly the
 * same empty state root behind. The second run is the only place the client's own launch of a Host is
 * exercised at all - from the bundle, where the paths and the executable are not the ones any unit
 * test sees.
 *
 * Unit tests never construct a BrowserWindow, so this is the only automated place the preload path,
 * the CSP, two renderer processes, native resvg binding and the composition order are proven
 * together. Both runs use their own temporary config directory and isolated state root, so neither
 * touches the machine's own %LOCALAPPDATA%\jamat-v3, a window the developer has open, or a Host they
 * are working with.
 */
import { SmokeHarness } from './smokeHarness.js'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'

class SmokeUi extends SmokeHarness {
  private static readonly packageDirConst = join(import.meta.dirname, '..', '..', 'app-client-ui')
  private static readonly channelConst = 'development'
  private static readonly bootTimeoutMillisecondsConst = 90_000
  /** The Host boots through tsx, which compiles the whole package before it listens. */
  private static readonly hostTimeoutMillisecondsConst = 90_000
  private static readonly pollMillisecondsConst = 250
  private static readonly mediaFileNameConst = 'protocol-range.gif'
  private static readonly mediaBytesConst = Uint8Array.from([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0,
    255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
  ])

  static async run(): Promise<void> {
    SmokeUi.build()
    await SmokeUi.checkSmokeStartsNoHost()
    await SmokeUi.checkAutoStartStartsAHost()
    console.log('[smoke:ui] OK')
  }

  private static async checkSmokeStartsNoHost(): Promise<void> {
    const stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-smoke-state-'))
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-smoke-config-'))
    try {
      writeFileSync(join(configDir, SmokeUi.mediaFileNameConst), SmokeUi.mediaBytesConst)
      await SmokeUi.boot(stateRoot, configDir)
      // `--smoke` switches the Host auto-start off, and this is what holds it to that: only a Host
      // publishes anything under the `host/` scope of the state root, so a directory there means this
      // run spawned a detached process against the machine it was supposed to leave alone.
      const hostScope = join(stateRoot, 'host')
      if (existsSync(hostScope))
        throw new Error(`the smoke run started a Host: ${hostScope} exists`)
      console.log('[smoke:ui] a --smoke run boots the shell and starts no Host')
    } finally {
      SmokeUi.discard(stateRoot)
      SmokeUi.discard(configDir)
    }
  }

  /**
   * The client is left to start its own Host and has to succeed at it. The descriptor is the Host's
   * own word that it is listening, and nothing else in this repository writes one, so its appearance
   * under this run's private scope is the whole assertion.
   */
  private static async checkAutoStartStartsAHost(): Promise<void> {
    const stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-autostart-state-'))
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-ui-autostart-config-'))
    // Read by HostDescriptorPaths below, and pinned for the child too: the descriptor this run waits
    // for must be the one its own Host publishes, never the developer's.
    process.env.JAMAT_V3_HOST_STATE_DIR = join(stateRoot, 'host')
    const identity = ConfigIdentityStore.loadOrCreate(configDir, SmokeUi.channelConst)
    const descriptorFile = HostDescriptorPaths.descriptorFile(
      identity.configIdentity,
      SmokeUi.channelConst,
    )
    const child = SmokeUi.spawnClient(stateRoot, configDir, [])
    const output = SmokeUi.collect(child)
    try {
      await SmokeUi.waitForDescriptor(descriptorFile, child, output)
      const descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8')) as HostDescriptor
      console.log(`[smoke:ui] the client started a Host of its own: pid ${
        descriptor.pid} on port ${descriptor.port}`)
    } finally {
      await SmokeUi.retireClient(child)
      await SmokeUi.retireHost(descriptorFile)
      SmokeUi.discard(stateRoot)
      SmokeUi.discard(configDir)
    }
  }

  private static build(): void {
    // One command string, no argument array: Node refuses to spawn a `.cmd` without a shell, and
    // passing args alongside `shell: true` is what it deprecates. Both arguments are literals.
    const built = spawnSync('pnpm run build', {
      cwd: SmokeUi.packageDirConst,
      stdio: 'inherit',
      shell: true,
    })
    if (built.status !== 0)
      throw new Error(`app-client-ui build failed with status ${built.status}`)
  }

  private static electronBinary(): string {
    const binary = process.platform === 'win32'
      ? join(SmokeUi.packageDirConst, 'node_modules', 'electron', 'dist', 'electron.exe')
      : join(SmokeUi.packageDirConst, 'node_modules', '.bin', 'electron')
    if (!existsSync(binary))
      throw new Error(`Electron is not installed in app-client-ui: ${binary}`)
    return binary
  }

  private static spawnClient(
    stateRoot: string,
    configDir: string,
    extraArgs: string[],
  ): ChildProcess {
    return spawn(SmokeUi.electronBinary(), [SmokeUi.packageDirConst, ...extraArgs], {
      env: {
        ...process.env,
        JAMAT_V3_LOCAL_STATE_DIR: stateRoot,
        // Pinned rather than left to the default, which is what this run inherits: the client now
        // reads a Host descriptor, and a developer with this variable exported would otherwise
        // have the smoke attach to the Host they are working with and take its controller lease.
        JAMAT_V3_HOST_STATE_DIR: join(stateRoot, 'host'),
        JAMAT_V3_CONFIG_DIR: configDir,
        JAMAT_V3_RUNTIME_CHANNEL: SmokeUi.channelConst,
        JAMAT_V3_SMOKE_MEDIA_PATH: join(configDir, SmokeUi.mediaFileNameConst),
        // The same pinning, for the two homes that are not ours. The rate monitor reads whatever
        // login the running agents keep here, so an inherited value would have every boot of this
        // smoke spend one counted request against the developer's own Claude account, on an endpoint
        // that answers a client asking too often with a 429 that then stands. Pointed at this run's
        // own directory Claude finds no credentials file and answers `unconfigured` without making
        // the request, which is the one this pinning is for. Codex is not the same: it answers
        // `unconfigured` only when it is not installed, so an installed one still spawns a real
        // app-server here and `CODEX_HOME` only moves which account it looks for. The boot is still
        // what is being proved. Reading them for real is `smoke:rate-monitor`, which exists for it.
        CLAUDE_CONFIG_DIR: configDir,
        CODEX_HOME: configDir,
      },
    })
  }

  private static collect(child: ChildProcess): { text: string } {
    const output = { text: '' }
    child.stdout?.on('data', (chunk: Buffer) => { output.text += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output.text += chunk.toString() })
    return output
  }

  private static boot(stateRoot: string, configDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = SmokeUi.spawnClient(stateRoot, configDir, ['--smoke'])
      const output = SmokeUi.collect(child)
      let settled = false
      const finish = (error: Error | null): void => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        if (!child.killed)
          child.kill()
        if (error)
          reject(error)
        else
          resolve()
      }
      const timer = setTimeout(
        () => finish(new Error(`app-client-ui did not report SMOKE OK in ${
          SmokeUi.bootTimeoutMillisecondsConst} ms; output so far:\n${output.text}`)),
        SmokeUi.bootTimeoutMillisecondsConst,
      )
      child.on('error', (error) => finish(error))
      child.on('exit', (code) => finish(
        output.text.includes('SMOKE OK') && code === 0
          ? null
          : new Error(`app-client-ui smoke exited with ${code}; output:\n${output.text}`),
      ))
    })
  }

  /**
   * A client that died is reported as itself rather than waited out, and the client's own error
   * channel is carried into the message: a spawn that failed says why on stderr, which is precisely
   * what an assertion about an absent descriptor could never tell anybody.
   */
  private static async waitForDescriptor(
    descriptorFile: string,
    child: ChildProcess,
    output: { text: string },
  ): Promise<void> {
    const deadline = Date.now() + SmokeUi.hostTimeoutMillisecondsConst
    while (Date.now() < deadline) {
      if (existsSync(descriptorFile)) return
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`the client exited with ${child.exitCode ?? child.signalCode} before it `
          + `started a Host; output:\n${output.text}`)
      await SmokeHarness.sleep(SmokeUi.pollMillisecondsConst)
    }
    throw new Error(`the client never started a Host: ${descriptorFile} never appeared in ${
      SmokeUi.hostTimeoutMillisecondsConst} ms; output:\n${output.text}`)
  }

  /** Awaited, not only signalled: the state root is about to be deleted out from under it. */
  private static async retireClient(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    const deadline = Date.now() + SmokeUi.bootTimeoutMillisecondsConst
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return
      await SmokeHarness.sleep(SmokeUi.pollMillisecondsConst)
    }
    throw new Error('the client this run started never exited')
  }

  /**
   * The Host outlives the client that asked for it, which is the whole point of it - so this run has
   * to take it down itself, and it reads the descriptor rather than a remembered pid so that a run
   * which failed for some other reason still leaves no Host behind.
   */
  private static async retireHost(descriptorFile: string): Promise<void> {
    if (!existsSync(descriptorFile)) return
    const pid = (JSON.parse(readFileSync(descriptorFile, 'utf8')) as HostDescriptor).pid
    try { process.kill(pid) }
    catch { return }
    const deadline = Date.now() + SmokeUi.bootTimeoutMillisecondsConst
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) }
      catch { return }
      await SmokeHarness.sleep(SmokeUi.pollMillisecondsConst)
    }
    throw new Error(`the Host this run started (pid ${pid}) never exited`)
  }

  /**
   * A temporary directory Windows still holds a handle to is not a verdict about the client, so it is
   * reported and not thrown: this run answers whether a Host started, nothing else.
   */
  private static discard(directory: string): void {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
    catch (error) {
      console.warn(`[smoke:ui] ${directory} could not be removed: ${
        error instanceof Error ? error.message : String(error)}`)
    }
  }

}

/*
 * The stack rather than the message, and `SmokeRun.failed` therefore not used here: this one boots a
 * real Electron window, where a failure is as likely to be a renderer throwing three frames deep as
 * a check that did not hold. The ending is the same - `process.exit(1)`, so a failed run cannot
 * wait on a window that is still up.
 */
void SmokeUi.run().catch((error: unknown) => {
  console.error(`[smoke:ui] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
