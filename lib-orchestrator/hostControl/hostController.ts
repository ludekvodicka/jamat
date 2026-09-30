import { spawn, type ChildProcess } from 'node:child_process'

import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import type { HostClient } from '../hostClient/hostClient'
import type { HostCallResult, HostConnectionPresence } from '../hostClient/hostClient.types'
import type { RuntimeChannel } from '../shared/configIdentity.types'
import { ErrorText } from '../shared/errorText'
import type { HostDebugStatus, HostPresence } from '../sessionManager/sessionManagerApi.types'
import { HostLaunchLocator } from './hostLaunchLocator'

export type HostStartErrorCode = 'already-running' | 'spawn-failed' | 'boot-timeout'

export type HostStartResult =
  | { ok: true }
  | { ok: false; code: HostStartErrorCode; detail: string }

export type HostRestartResult = HostCallResult<void> | Extract<HostStartResult, { ok: false }>

export type HostStopResult = HostCallResult<void> | { ok: false; code: 'already-running'; detail: string }

export interface HostControllerDeps {
  /**
   * The directory `app-host` stands in. It is the client's to name: this library is bundled into it,
   * so nothing here can measure where the tree it came from is.
   */
  applicationRoot: string
  /**
   * Electron's `process.resourcesPath` in a packaged client, where the Host ships as a bundle under
   * `host/`. `null` everywhere else, and stated rather than defaulted: a composer that forgets it
   * would refuse every session in an installed client and nothing would say why.
   */
  resourcesRoot: string | null
  configDir: string
  channel: RuntimeChannel
  /** The transport fact, from `HostClient`. The `starting` overlay on top of it is this class's. */
  presenceOf: () => HostConnectionPresence
  descriptorOf: () => HostDescriptor | null
  stopHost: HostClient['stopHost']
  onError: (message: string) => void
  /** The tests script every launch through this; nothing in production passes it. */
  spawnImpl?: typeof spawn
  bootTimeoutMilliseconds?: number
  presencePollMilliseconds?: number
}

interface LaunchEvidence {
  spawnError: string | null
  exited: string | null
}

/**
 * Host presence and explicit launches or restarts. Client shutdown still only detaches.
 */
export class HostController {
  private static readonly bootTimeoutMillisecondsConst = 15_000
  private static readonly presencePollMillisecondsConst = 100

  private launching = false
  private stopping = false
  private attempted = false
  private lastStartErrorValue: string | null = null

  constructor(private readonly deps: HostControllerDeps) {}

  /**
   * One automatic attempt for the life of this client, never a retry loop and never per operation: a
   * Host that will not start has to stay visibly not started, rather than be buried under spawns that
   * fail the same way every time.
   */
  async ensureRunningOnce(): Promise<void> {
    if (this.attempted) return
    this.attempted = true
    await this.start()
  }

  /** Refused while a Host is running and while a launch is in flight. Never throws. */
  async start(): Promise<HostStartResult> {
    return this.record(await this.attempt())
  }

  async restart(expectedHostInstanceId: string): Promise<HostRestartResult> {
    if (this.launching || this.stopping)
      return { ok: false, code: 'already-running', detail: 'A Host launch, stop or restart is already in flight' }
    if (this.deps.presenceOf() !== 'running'
      || this.deps.descriptorOf()?.hostInstanceId !== expectedHostInstanceId)
      return { ok: false, code: 'host-unreachable', detail: 'The Host changed before the restart. Try again.' }
    const located = HostLaunchLocator.launch(
      { applicationRoot: this.deps.applicationRoot, resourcesRoot: this.deps.resourcesRoot },
      this.deps.configDir,
      this.deps.channel,
    )
    if (!located.ok) return HostController.spawnFailed(located.reason)
    this.launching = true
    try {
      const stopped = await this.stopAndWait(expectedHostInstanceId)
      if (!stopped.ok) return stopped
      const started = this.record(await (this.deps.descriptorOf() === null
        ? this.launch()
        : this.awaitRunning({ spawnError: null, exited: null })))
      return started.ok ? { ok: true, value: undefined } : started
    } finally {
      this.launching = false
    }
  }

  /** Stops the running Host without a replacement; a later `start` launches one from this client's tree. */
  async stop(expectedHostInstanceId: string): Promise<HostStopResult> {
    if (this.launching || this.stopping)
      return { ok: false, code: 'already-running', detail: 'A Host launch, stop or restart is already in flight' }
    if (this.deps.presenceOf() !== 'running'
      || this.deps.descriptorOf()?.hostInstanceId !== expectedHostInstanceId)
      return { ok: false, code: 'host-unreachable', detail: 'The Host changed before the stop. Try again.' }
    this.stopping = true
    try {
      return await this.stopAndWait(expectedHostInstanceId)
    } finally {
      this.stopping = false
    }
  }

  presence(): HostPresence {
    const connection = this.deps.presenceOf()
    if (connection === 'running') return 'running'
    else if (connection === 'unreachable') return this.launching ? 'starting' : 'unreachable'
    else throw new Error(`Unknown Host connection presence: ${JSON.stringify(connection)}`)
  }

  hostVersion(): string | null {
    return this.deps.descriptorOf()?.hostVersion ?? null
  }

  hostInstanceId(): string | null {
    return this.deps.descriptorOf()?.hostInstanceId ?? null
  }

  lastStartError(): string | null {
    return this.lastStartErrorValue
  }

  /**
   * The launch state behind `presence`: whether a spawn is in flight, whether the one automatic
   * attempt has been spent, and what the last one said. Read only by the debug surface - the
   * snapshot shows presence and the error, which is all a status bar can act on.
   */
  debugView(): HostDebugStatus['controller'] {
    return {
      launching: this.launching,
      autoStartAttempted: this.attempted,
      lastStartError: this.lastStartErrorValue,
    }
  }

  private async stopAndWait(expectedHostInstanceId: string): Promise<HostCallResult<void>> {
    const stopped = await this.deps.stopHost(expectedHostInstanceId)
    if (!stopped.ok) return stopped
    const timeout = this.deps.bootTimeoutMilliseconds ?? HostController.bootTimeoutMillisecondsConst
    const deadline = Date.now() + timeout
    // A disconnected socket alone does not prove shutdown. Wait for the old descriptor to go.
    while (this.deps.descriptorOf()?.hostInstanceId === expectedHostInstanceId) {
      if (Date.now() >= deadline)
        return { ok: false, code: 'host-unreachable', detail: `The old Host did not finish stopping within ${timeout} ms` }
      await HostController.delay(this.deps.presencePollMilliseconds ?? HostController.presencePollMillisecondsConst)
    }
    return { ok: true, value: undefined }
  }

  private async attempt(): Promise<HostStartResult> {
    if (this.launching)
      return { ok: false, code: 'already-running', detail: 'A Host launch is already in flight' }
    // The old Host may still hold its descriptor; a spawn now would be refused by its process lock.
    if (this.stopping)
      return { ok: false, code: 'already-running', detail: 'A Host stop is still in flight' }
    if (this.deps.presenceOf() === 'running')
      return { ok: false, code: 'already-running', detail: 'The Host is already running' }
    this.launching = true
    try {
      return await this.launch()
    } finally {
      this.launching = false
    }
  }

  private async launch(): Promise<HostStartResult> {
    const located = HostLaunchLocator.launch(
      { applicationRoot: this.deps.applicationRoot, resourcesRoot: this.deps.resourcesRoot },
      this.deps.configDir,
      this.deps.channel,
    )
    // A tree that cannot start a Host is answered here, in the time it takes to look: the alternative
    // is a spawn that succeeds, a child that dies on the spot and a caller left waiting out the boot
    // deadline for a message naming an exit code it can do nothing with. It travels as `spawn-failed`
    // because that is what the caller acts on - no Host was started, and the reason says why in words
    // the user can act on; `boot-timeout` is reserved for a Host that really was launched and never
    // answered.
    if (!located.ok) return HostController.spawnFailed(located.reason)
    const command = located.launch
    const evidence: LaunchEvidence = { spawnError: null, exited: null }
    let child: ChildProcess
    try {
      // The environment is the locator's, and it is this process's own plus one switch. Passing it
      // rather than letting the child inherit changes nothing about the JAMAT_V3_* override of the
      // state root reaching the Host - it is copied in whole - and it is what makes an Electron
      // `process.execPath` run the entry point instead of a second application.
      child = (this.deps.spawnImpl ?? spawn)(command.command, command.args, {
        cwd: command.cwd,
        env: command.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      return HostController.spawnFailed(ErrorText.of(error))
    }
    child.once('error', (error) => {
      evidence.spawnError = ErrorText.of(error)
    })
    child.once('exit', (code, signal) => {
      evidence.exited = HostController.exitText(code, signal)
    })
    // The Host has to outlive the client that asked for it.
    child.unref()
    return this.awaitRunning(evidence)
  }

  private async awaitRunning(evidence: LaunchEvidence): Promise<HostStartResult> {
    const timeout = this.deps.bootTimeoutMilliseconds ?? HostController.bootTimeoutMillisecondsConst
    const poll = this.deps.presencePollMilliseconds ?? HostController.presencePollMillisecondsConst
    const deadline = Date.now() + timeout
    for (;;) {
      // Presence is asked first on purpose. Two clients starting at once is ordinary, the Host's own
      // process lock refuses the loser, and the descriptor that appeared is exactly what this call
      // wanted: a lost race is a success, whichever process published it.
      if (this.deps.presenceOf() === 'running') return { ok: true }
      if (evidence.spawnError !== null)
        return HostController.spawnFailed(evidence.spawnError)
      if (Date.now() >= deadline)
        return {
          ok: false,
          code: 'boot-timeout',
          detail: `The Host did not answer within ${timeout} ms`
            + (evidence.exited === null ? '' : ` (the process ${evidence.exited})`),
        }
      await HostController.delay(poll)
    }
  }

  private record(result: HostStartResult): HostStartResult {
    if (result.ok) {
      this.lastStartErrorValue = null
      return result
    }
    // A refusal describes this call, not the Host: a snapshot must never show "already running" as
    // the reason no Host is there.
    else if (result.code === 'already-running') return result
    else if (result.code === 'spawn-failed') return this.fail(result)
    else if (result.code === 'boot-timeout') return this.fail(result)
    else throw new Error(`Unknown Host start result: ${JSON.stringify(result)}`)
  }

  private fail(result: Extract<HostStartResult, { ok: false }>): HostStartResult {
    this.lastStartErrorValue = result.detail
    this.deps.onError(result.detail)
    return result
  }

  private static spawnFailed(reason: string): Extract<HostStartResult, { ok: false }> {
    return { ok: false, code: 'spawn-failed', detail: `The Host could not be started: ${reason}` }
  }

  private static exitText(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal !== null) return `exited on ${signal}`
    return `exited with code ${code}`
  }

  private static delay(milliseconds: number): Promise<void> {
    return new Promise((settle) => setTimeout(settle, milliseconds))
  }
}
