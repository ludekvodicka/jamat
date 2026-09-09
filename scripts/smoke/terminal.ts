/**
 * End-to-end proof that the terminal attach works against a real AppHost, a real PTY and the real
 * projection: a session created through the manager, attached to as a writer, the screen it was
 * holding before anyone looked, a keystroke reaching the shell and its output coming back, a resize
 * that travels and a second identical one that does not, and an attach opened after the first was
 * closed, which has to rebuild the screen from a snapshot rather than from anything it remembered.
 *
 * Unit tests drive the gateway against a socket that is two arrays, so this is the only place the
 * attach meets a Host that can refuse it. No Electron: plain Node through tsx.
 *
 * Everything lives under one temporary root - the config directory, the machine state root of both
 * the Host and the orchestrator, and the working directory the session runs in - so the machine's
 * own %LOCALAPPDATA%\jamat-v3 and ~/.jamat-v3 are never read and never written.
 */
import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager.js'
import type {
  SessionInfo,
  SessionsOpResult,
  TerminalFrame,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'

class SmokeTerminal extends SmokeHarness {
  protected override get waitMilliseconds(): number {
    return SmokeTerminal.settleMillisecondsConst
  }

  private static readonly channelConst = 'development'
  private static readonly controllerIdConst = 'jamat-terminal-smoke'
  private static readonly hostBootMillisecondsConst = 30_000
  private static readonly settleMillisecondsConst = 30_000
  private static readonly repoRootConst = join(import.meta.dirname, '..', '..')
  private static readonly firstAttachConst = 'smoke-attach-1'
  private static readonly secondAttachConst = 'smoke-attach-2'
  private static readonly markerConst = 'smoke-terminal-marker'
  private static readonly longMarkerConst = 'smoke-terminal-long-marker'
  /** Comfortably past the Host's 4096, and well inside every shell's own command line limit. */
  private static readonly oversizedInputCharactersConst = 4_200
  /**
   * How long a resize is given to NOT arrive. The Host publishes a resize to its attachments as soon
   * as the PTY takes it, so anything this side of a second is generous for proving one never came.
   */
  private static readonly silenceMillisecondsConst = 1_500

  private readonly configDir: string
  private readonly stateRoot: string
  private readonly workDir: string
  private readonly descriptorFile: string
  private readonly errors: string[] = []
  private readonly frames: { attachId: string; frame: TerminalFrame }[] = []
  private readonly manager: SessionManager
  private host: ChildProcess | null = null

  private constructor(root: string) {
    super()
    this.configDir = join(root, 'config')
    this.stateRoot = join(root, 'state')
    this.workDir = join(root, 'work')
    mkdirSync(this.workDir, { recursive: true })
    process.env.JAMAT_V3_LOCAL_STATE_DIR = this.stateRoot
    process.env.JAMAT_V3_HOST_STATE_DIR = join(this.stateRoot, 'host')
    const configIdentity = ConfigIdentityStore
      .loadOrCreate(this.configDir, SmokeTerminal.channelConst)
      .configIdentity
    this.descriptorFile = HostDescriptorPaths
      .descriptorFile(configIdentity, SmokeTerminal.channelConst)
    this.manager = new SessionManager({
      applicationRoot: SmokeTerminal.repoRootConst,
      // A source tree: the Host starts from `app-host/start.ts`, never from a packaged bundle.
      resourcesRoot: null,
      configDir: this.configDir,
      configIdentity,
      channel: SmokeTerminal.channelConst,
      // The Host of this run is the one spawned below; nothing here may launch a detached one.
      autoStartHost: false,
      onChanged: () => {},
      onError: (message) => { this.errors.push(message) },
      controllerId: SmokeTerminal.controllerIdConst,
    })
  }

  static async run(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-terminal-smoke-'))
    const smoke = new SmokeTerminal(root)
    try {
      await smoke.execute()
    } finally {
      await smoke.retire()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  private async execute(): Promise<void> {
    this.host = this.spawnHost()
    await this.waitForDescriptor()
    await this.manager.start()
    await this.waitUntil(
      () => this.manager.snapshot().host.presence === 'running',
      'the manager never reached the Host',
    )

    const sessionId = await this.checkLiveSession()
    await this.checkAttach(sessionId)
    await this.checkInput()
    await this.checkInputPastTheWireLimit()
    await this.checkResizeIsSentOnlyWhenItMoved()
    await this.checkSecondAttachRebuildsFromSnapshot(sessionId)
    await this.checkStop(sessionId)

    this.check(`nothing was reported through onError (${this.errors.join(' | ')})`,
      this.errors.length === 0)
    console.log(`\nsmoke-terminal: ${this.passed} checks passed`)
  }

  private async checkLiveSession(): Promise<string> {
    const created = SmokeTerminal.valueOf(
      await this.manager.createSession({
        kind: 'shell',
        directory: { mode: 'adHoc', path: this.workDir },
      }),
      'createSession',
    )
    await this.waitUntil(
      () => this.sessionOf(created.sessionId)?.life === 'live',
      'the session never went live',
    )
    // The shell writing its prompt is what makes the next check about a screen rather than about
    // an empty buffer. Asked of the DIAGNOSTIC surface: the counter left `SessionInfo` on
    // 2026-08-24 because nothing drew it and it woke every window once a poll.
    await this.waitUntil(
      () => (this.manager.debugStatus().runtimes
        .find((row) => row.runtimeSessionId === created.sessionId)?.outputSeq ?? 0) > 0,
      'the session never produced any output',
    )
    this.check('a shell session is live on the Host', true)
    return created.sessionId
  }

  private async checkAttach(sessionId: string): Promise<void> {
    const attached = this.manager.terminalAttach(SmokeTerminal.firstAttachConst, {
      sessionId,
      size: { cols: 100, rows: 30 },
    }, {
      source: 'local',
      onFrame: (frame) => {
        this.frames.push({ attachId: SmokeTerminal.firstAttachConst, frame })
      },
    })
    this.check('the attach was accepted', attached.ok)

    await this.waitForFrame(SmokeTerminal.firstAttachConst, 'terminal.attached',
      'the Host never answered the attach')
    const answer = this.frameOf(SmokeTerminal.firstAttachConst, 'terminal.attached')
    this.check('it attached as a writer, under the lease the manager already holds',
      answer.type === 'terminal.attached' && answer.writer)

    await this.waitForFrame(SmokeTerminal.firstAttachConst, 'terminal.snapshot',
      'no snapshot arrived for an attach that carried no cursor')
    const snapshot = this.frameOf(SmokeTerminal.firstAttachConst, 'terminal.snapshot')
    if (snapshot.type !== 'terminal.snapshot') throw new Error('FAILED: not a snapshot')
    this.check('the snapshot carries the screen the session had before anyone looked',
      snapshot.projection.screen.length > 0)
    // The geometry rode the attach frame, so the PTY is already the size the surface asked for.
    this.check(`the PTY took the size the attach asked for (${snapshot.projection.cols}x${snapshot.projection.rows})`,
      snapshot.projection.cols === 100 && snapshot.projection.rows === 30)
  }

  private async checkInput(): Promise<void> {
    this.manager.terminalInput(SmokeTerminal.firstAttachConst, `echo ${SmokeTerminal.markerConst}\r`)
    await this.waitUntil(
      () => this.textOf(SmokeTerminal.firstAttachConst).includes(SmokeTerminal.markerConst),
      'what was typed never came back out',
    )
    this.check('a keystroke reached the shell and its output came back', true)
  }

  /**
   * The one the unit tests cannot prove: a real Host, which refuses a `terminal.input` frame over
   * `HostWireConst.maxInputBytes`, and a real PTY that has to end up with every byte in order. A
   * 4 KB clipboard is ordinary, and pasting one used to answer `bad-request`, lose the screen and
   * leave the session running with nothing attached to it.
   *
   * The marker rides at the END of the long argument, so it can only come back if the whole input
   * arrived and arrived in order.
   */
  private async checkInputPastTheWireLimit(): Promise<void> {
    const long = 'x'.repeat(SmokeTerminal.oversizedInputCharactersConst)
    this.manager.terminalInput(SmokeTerminal.firstAttachConst,
      `echo ${long}${SmokeTerminal.longMarkerConst}\r`)
    await this.waitUntil(
      () => this.textOf(SmokeTerminal.firstAttachConst).includes(SmokeTerminal.longMarkerConst),
      'an input past the wire limit never reached the shell',
    )
    this.check('an input past the wire limit arrived whole and in order', true)
    this.check(`the attach survived it (${this.errors.join(' | ')})`, this.errors.length === 0)
  }

  /**
   * The second half is the one that matters. Revealing a hidden tab recomputes the size it already
   * had, and a resize the PTY already has still triggers a ConPTY reflow that corrupts wide and
   * box-drawing characters, so a resize that did not move must never leave this client.
   */
  private async checkResizeIsSentOnlyWhenItMoved(): Promise<void> {
    this.manager.terminalResize(SmokeTerminal.firstAttachConst, 120, 40)
    await this.waitUntil(
      () => this.resizesOf(SmokeTerminal.firstAttachConst)
        .some((frame) => frame.cols === 120 && frame.rows === 40),
      'the resize never reached the PTY',
    )
    this.check('a resize that moved reached the PTY', true)

    const before = this.resizesOf(SmokeTerminal.firstAttachConst).length
    this.manager.terminalResize(SmokeTerminal.firstAttachConst, 120, 40)
    await SmokeHarness.sleep(SmokeTerminal.silenceMillisecondsConst)
    this.check('a resize to the size it already had reached nothing',
      this.resizesOf(SmokeTerminal.firstAttachConst).length === before)
  }

  private async checkSecondAttachRebuildsFromSnapshot(sessionId: string): Promise<void> {
    this.manager.terminalDetach(SmokeTerminal.firstAttachConst)
    const attached = this.manager.terminalAttach(SmokeTerminal.secondAttachConst, {
      sessionId,
      size: null,
    }, {
      source: 'local',
      onFrame: (frame) => {
        this.frames.push({ attachId: SmokeTerminal.secondAttachConst, frame })
      },
    })
    this.check('a second attach on the same session was accepted', attached.ok)

    await this.waitForFrame(SmokeTerminal.secondAttachConst, 'terminal.snapshot',
      'the second attach never got a snapshot')
    const snapshot = this.frameOf(SmokeTerminal.secondAttachConst, 'terminal.snapshot')
    if (snapshot.type !== 'terminal.snapshot') throw new Error('FAILED: not a snapshot')
    // Nothing was remembered across the two attaches: this text can only have come from the Host's
    // own projection of the session.
    this.check('it rebuilt what the first attach had seen, out of the Host\'s projection',
      snapshot.projection.screen.includes(SmokeTerminal.markerConst))
    this.check('an attach with no size left the PTY at the size it already had',
      snapshot.projection.cols === 120 && snapshot.projection.rows === 40)
  }

  private async checkStop(sessionId: string): Promise<void> {
    SmokeTerminal.valueOf(await this.manager.stopSession(sessionId), 'stopSession')
    await this.waitForFrame(SmokeTerminal.secondAttachConst, 'terminal.exit',
      'the attach never heard that the runtime had gone')
    this.check('a stopped runtime reaches the attach as an exit', true)
    // The exit is the end of that attach: nothing after it is addressed to anybody.
    this.manager.terminalDetach(SmokeTerminal.secondAttachConst)
    this.check('the session ended', this.sessionOf(sessionId)?.life === 'ended')
  }

  private framesOf(attachId: string): TerminalFrame[] {
    return this.frames.filter((entry) => entry.attachId === attachId).map((entry) => entry.frame)
  }

  private frameOf(attachId: string, type: TerminalFrame['type']): TerminalFrame {
    const found = this.framesOf(attachId).find((frame) => frame.type === type)
    if (!found) throw new Error(`FAILED: no ${type} frame for ${attachId}`)
    return found
  }

  private resizesOf(attachId: string): { cols: number; rows: number }[] {
    return this.framesOf(attachId)
      .filter((frame) => frame.type === 'terminal.resize')
      .map((frame) => ({ cols: frame.cols, rows: frame.rows }))
  }

  /** Everything this attach has been shown, snapshot and live output alike, as one string. */
  private textOf(attachId: string): string {
    return this.framesOf(attachId)
      .map((frame) => {
        if (frame.type === 'terminal.snapshot') return frame.projection.screen
        else if (frame.type === 'terminal.data') return frame.delta
        else if (frame.type === 'terminal.delta') return frame.data
        else return ''
      })
      .join('')
  }

  private async waitForFrame(
    attachId: string,
    type: TerminalFrame['type'],
    failure: string,
  ): Promise<void> {
    await this.waitUntil(
      () => this.framesOf(attachId).some((frame) => frame.type === type),
      failure,
    )
  }

  private spawnHost(): ChildProcess {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(SmokeTerminal.repoRootConst, 'app-host', 'start.ts'),
        '--config-dir', this.configDir, '--channel', SmokeTerminal.channelConst],
      {
        cwd: SmokeTerminal.repoRootConst,
        env: { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: this.stateRoot },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    )
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`  host! ${chunk}`))
    return child
  }

  /** Detach, then take the Host down with the runtimes it owns: this root is about to be deleted. */
  private async retire(): Promise<void> {
    await this.manager.stop()
    const child = this.host
    this.host = null
    if (child === null || child.exitCode !== null) return
    child.kill()
    await this.waitUntil(() => child.exitCode !== null || child.signalCode !== null,
      'the Host process never exited')
  }

  private async waitForDescriptor(): Promise<void> {
    const deadline = Date.now() + SmokeTerminal.hostBootMillisecondsConst
    while (Date.now() < deadline) {
      if (existsSync(this.descriptorFile)) return
      await SmokeHarness.sleep(150)
    }
    throw new Error(`the Host never published ${this.descriptorFile}`)
  }

  private sessionOf(sessionId: string): SessionInfo | undefined {
    return this.manager.snapshot().sessions.find((session) => session.sessionId === sessionId)
  }

  private static valueOf<T>(result: SessionsOpResult<T>, operation: string): T {
    if (!result.ok)
      throw new Error(`FAILED: ${operation} refused with ${result.code}: ${result.detail}`)
    return result.value
  }


}

void SmokeTerminal.run().catch((error: unknown) => SmokeRun.failed('smoke-terminal', error))
