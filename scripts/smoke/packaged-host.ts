/**
 * End-to-end proof that an INSTALLED Jamat can start a Host of its own. Everything else about the
 * packaged Host is arrangement - a bundle in `resources/host`, a locator branch, a FileSet - and
 * arrangement is exactly what looks right and does not run.
 *
 * The three things only this script can prove, because they need the real packaged layout:
 *
 * 1. `build.extraResources` really carried `out/host-bundle/current` into `resources/host`, whole:
 *    the bundle's own manifest records the tree it was published with, and it is re-hashed here.
 * 2. `Jamat.exe` under `ELECTRON_RUN_AS_NODE` runs that bundle as a Host. The runtime there is
 *    ELECTRON's Node, not this machine's, which is why the prebuilt `node-pty` binding is proven by
 *    spawning a real PTY and reading its output back rather than by loading the module and stopping.
 * 3. `HostLaunchLocator` composes the packaged command correctly. The arguments and the environment
 *    come from the real locator, not from a copy written here; only the executable is substituted,
 *    since `process.execPath` in this script is the Node running the smoke.
 *
 * It runs against a state root and a config directory of its own, and every `JAMAT_V3_*` variable
 * this machine carries is dropped before anything is composed, so a Host the developer is using is
 * neither read nor disturbed.
 *
 * Requires `pnpm package:ui:win:dir` to have produced `app-client-ui/dist/win-unpacked`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { WebSocket } from 'ws'

import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import { HostLaunchLocator } from '../../lib-orchestrator/hostControl/hostLaunchLocator.js'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore.js'
import { SmokeHarness, SmokeRun } from './smokeHarness.js'

import type {
  ControllerLeaseResult,
  HostDescriptor,
  HostWsServerMsg,
  RuntimeInspectResult,
  RuntimeMutationAck,
  RuntimeRef,
  RuntimeResult,
} from '../../app-host/app/wire/hostWire.js'

interface HostBundleManifest {
  schemaVersion: 1
  entry: string
  host: { name: string; version: string }
  nodePty: { version: string }
  runtime: { platform: string; arch: string }
  tree: { files: number; sha256: string }
}

class SmokePackagedHost extends SmokeHarness {
  protected override get waitMilliseconds(): number {
    return SmokePackagedHost.settleMillisecondsConst
  }

  private static readonly labelConst = '[smoke:packaged-host]'
  private static readonly channelConst = 'development'
  private static readonly bootMillisecondsConst = 60_000
  private static readonly settleMillisecondsConst = 30_000
  private static readonly markerConst = 'packaged-host-marker'
  private static readonly repoRootConst = resolve(import.meta.dirname, '..', '..')
  private static readonly packageRootConst = join(
    SmokePackagedHost.repoRootConst,
    'app-client-ui',
    'dist',
    'win-unpacked',
  )
  private static readonly resourcesRootConst = join(
    SmokePackagedHost.packageRootConst,
    'resources',
  )
  private static readonly bundleRootConst = join(SmokePackagedHost.resourcesRootConst, 'host')
  private static readonly executableConst = join(SmokePackagedHost.packageRootConst, 'Jamat.exe')

  private readonly configDir: string
  private readonly stateRoot: string
  private readonly descriptorFile: string
  private host: ChildProcess | null = null
  private hostExit: string | null = null

  private constructor(root: string) {
    super()
    this.configDir = join(root, 'config')
    this.stateRoot = join(root, 'state')
    // Dropped rather than overridden: this machine's own config directory, channel, build version
    // and payload hash are all `JAMAT_V3_*`, and every one of them would reach the packaged Host
    // through the locator's environment filter, which keeps Jamat variables on purpose.
    for (const key of Object.keys(process.env))
      if (key.startsWith('JAMAT')) delete process.env[key]
    process.env.JAMAT_V3_LOCAL_STATE_DIR = this.stateRoot
    process.env.JAMAT_V3_HOST_STATE_DIR = join(this.stateRoot, 'host')
    const configIdentity = ConfigIdentityStore
      .loadOrCreate(this.configDir, SmokePackagedHost.channelConst)
      .configIdentity
    this.descriptorFile = HostDescriptorPaths
      .descriptorFile(configIdentity, SmokePackagedHost.channelConst)
  }

  static async run(): Promise<void> {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error(`the packaged Host smoke supports only win32-x64, received ${
        process.platform}-${process.arch}`)
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-packaged-host-smoke-'))
    const smoke = new SmokePackagedHost(root)
    try {
      await smoke.execute()
      console.log(`${SmokePackagedHost.labelConst} OK (${smoke.passed} checks)`)
    } finally {
      smoke.retire()
      SmokePackagedHost.discard(root)
    }
  }

  private async execute(): Promise<void> {
    const manifest = this.checkLayout()
    const descriptor = await this.startHost()
    this.check(`the descriptor names the packaged Host version (${descriptor.hostVersion})`,
      descriptor.hostVersion === manifest.host.version)
    this.check(`the descriptor is on the smoke's own state root (${this.descriptorFile})`,
      existsSync(this.descriptorFile))
    await this.checkWire(descriptor)
    await this.checkPty(descriptor)
    await this.checkStop(descriptor)
  }

  /**
   * The FileSet, verified against the bundle's own record of itself. A partial copy is the failure
   * this catches: `extraResources` that drops `node_modules/node-pty` leaves an application that
   * starts, publishes a descriptor and then cannot spawn a single terminal.
   */
  private checkLayout(): HostBundleManifest {
    this.check(`the packaged application is unpacked at ${SmokePackagedHost.packageRootConst}`,
      existsSync(SmokePackagedHost.executableConst))
    this.check('the Host bundle rode along as an extra resource, outside app.asar',
      existsSync(join(SmokePackagedHost.resourcesRootConst, 'app.asar'))
        && existsSync(join(SmokePackagedHost.bundleRootConst, 'start.cjs')))
    const manifest = SmokePackagedHost.manifest()
    this.check(`the bundle records the Host package (${manifest.host.name} ${manifest.host.version})`,
      manifest.host.name.length > 0 && manifest.host.version.length > 0)
    this.check(`the bundle carries the node-pty binding for this platform (${
      manifest.runtime.platform}-${manifest.runtime.arch}, node-pty ${manifest.nodePty.version})`,
      manifest.runtime.platform === process.platform && manifest.runtime.arch === process.arch
        && existsSync(join(SmokePackagedHost.bundleRootConst, 'node_modules', 'node-pty',
          'prebuilds', `${process.platform}-${process.arch}`)))
    const tree = SmokePackagedHost.treeOf(SmokePackagedHost.bundleRootConst)
    this.check(`the packaged bundle is the published tree, file for file (${tree.files} files)`,
      tree.files === manifest.tree.files && tree.sha256 === manifest.tree.sha256)
    return manifest
  }

  /**
   * The command is the product's own. Only the executable is replaced: the locator names
   * `process.execPath`, which here is the Node running this script rather than the installed
   * Electron, and running the installed one is the whole point.
   */
  private async startHost(): Promise<HostDescriptor> {
    const located = HostLaunchLocator.launch(
      {
        applicationRoot: SmokePackagedHost.packageRootConst,
        resourcesRoot: SmokePackagedHost.resourcesRootConst,
      },
      this.configDir,
      SmokePackagedHost.channelConst,
    )
    if (!located.ok) throw new Error(`the packaged launch was refused: ${located.reason}`)
    this.check('the locator chose the packaged bundle, with no loader argument',
      located.launch.args[0] === join(SmokePackagedHost.bundleRootConst, 'start.cjs')
        && !located.launch.args.includes('tsx'))
    this.check('the locator asked for Electron to run as Node',
      located.launch.env.ELECTRON_RUN_AS_NODE === '1')

    const child = spawn(SmokePackagedHost.executableConst, located.launch.args, {
      cwd: located.launch.cwd,
      env: located.launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.host = child
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`  host| ${chunk}`))
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`  host! ${chunk}`))
    child.once('exit', (code, signal) => {
      this.hostExit = signal === null ? `exited with code ${code}` : `exited on ${signal}`
    })
    return await this.waitForDescriptor()
  }

  private async waitForDescriptor(): Promise<HostDescriptor> {
    const deadline = Date.now() + SmokePackagedHost.bootMillisecondsConst
    while (Date.now() < deadline) {
      if (existsSync(this.descriptorFile)) {
        const descriptor = JSON.parse(
          readFileSync(this.descriptorFile, 'utf8'),
        ) as HostDescriptor
        this.check(`the packaged Host published a descriptor (pid ${descriptor.pid}, port ${
          descriptor.port})`, descriptor.schemaVersion === 1)
        return descriptor
      }
      if (this.hostExit !== null)
        throw new Error(`the packaged Host ${this.hostExit} before publishing a descriptor`)
      await SmokeHarness.sleep(200)
    }
    throw new Error('the packaged Host never published a descriptor')
  }

  private async checkWire(descriptor: HostDescriptor): Promise<void> {
    this.check(`the wire major the client speaks is the one it answers (${descriptor.protocol.major})`,
      descriptor.protocol.major === 1)
    const unauthorized = await fetch(
      `http://127.0.0.1:${descriptor.port}/op/runtime.list`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    this.check(`an op without the descriptor token is refused (${unauthorized.status})`,
      unauthorized.status === 401)
    const listed = await SmokePackagedHost.op<{ sessions: unknown[] }>(
      descriptor, 'runtime.list', {},
    )
    this.check('the packaged Host answers runtime.list with no runtimes of its own',
      Array.isArray(listed.sessions) && listed.sessions.length === 0)
  }

  /**
   * The one thing a bundle cannot fake. `node-pty` is external and unpacked beside `start.cjs`, its
   * binding is a prebuild compiled against N-API, and it is being loaded by ELECTRON's Node here -
   * so a real child, real output and a real attach are what say the packaged Host works.
   */
  private async checkPty(descriptor: HostDescriptor): Promise<void> {
    const lease = await SmokePackagedHost.op<ControllerLeaseResult>(
      descriptor, 'controller.acquire', { controllerId: 'packaged-host-smoke' },
    )
    this.check('a controller lease is granted', typeof lease.controllerLeaseId === 'string')
    const created = await SmokePackagedHost.op<RuntimeResult>(descriptor, 'runtime.create', {
      controllerLeaseId: lease.controllerLeaseId,
      operationId: 'packaged-host-smoke-1',
      runtimeSessionId: 'packaged-host-smoke-shell',
      launch: {
        command: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/q', '/k', `echo ${SmokePackagedHost.markerConst}`],
        cwd: this.configDir,
        env: SmokePackagedHost.shellEnv(),
        cols: 100,
        rows: 30,
      },
    })
    this.check('the packaged Host spawned a real PTY through the bundled node-pty',
      created.session.alive)
    const target: RuntimeRef = {
      hostInstanceId: created.hostInstanceId,
      runtimeSessionId: created.session.runtimeSessionId,
      generation: created.session.generation,
    }
    await this.waitUntilAsync(
      async () => {
        const inspected = await SmokePackagedHost.op<RuntimeInspectResult>(
          descriptor, 'runtime.inspect', { target },
        )
        return inspected.projection?.raw.includes(SmokePackagedHost.markerConst) === true
      },
      `the PTY output never reached the projection (${SmokePackagedHost.markerConst})`,
    )
    this.check('the PTY output came back through the projection', true)
    await this.checkAttach(descriptor, lease.controllerLeaseId, target)
    const stopped = await SmokePackagedHost.op<RuntimeMutationAck>(descriptor, 'runtime.stop', {
      controllerLeaseId: lease.controllerLeaseId,
      target,
    })
    this.check(`an explicit stop ended the runtime (${stopped.diagnostic})`,
      stopped.diagnostic === 'stopped')
  }

  private async checkAttach(
    descriptor: HostDescriptor,
    controllerLeaseId: string,
    target: RuntimeRef,
  ): Promise<void> {
    const socket = await SmokePackagedHost.connect(descriptor)
    try {
      const frames: HostWsServerMsg[] = []
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString('utf8')) as HostWsServerMsg)
      })
      socket.send(JSON.stringify({
        type: 'terminal.attach', target, controllerLeaseId, role: 'interactive',
      }))
      await this.waitUntil(
        () => frames.some((frame) => frame.type === 'terminal.snapshot'),
        'the packaged Host never sent a snapshot for the attach',
      )
      this.check('an attach over the packaged Host delivered the screen', true)
      socket.send(JSON.stringify({
        type: 'terminal.input', data: `echo ${SmokePackagedHost.markerConst}-input\r`,
      }))
      await this.waitUntil(
        () => frames.some((frame) => frame.type === 'terminal.data'
          && frame.delta.includes(`${SmokePackagedHost.markerConst}-input`)),
        'the input never came back out of the packaged PTY',
      )
      this.check('input reached the PTY and its output came back', true)
    } finally {
      socket.close()
    }
  }

  /** Closing a client only detaches; only this ends a Host, and it has to actually end it. */
  private async checkStop(descriptor: HostDescriptor): Promise<void> {
    const lease = await SmokePackagedHost.op<ControllerLeaseResult>(
      descriptor, 'controller.acquire', { controllerId: 'packaged-host-smoke' },
    )
    const stopping = await SmokePackagedHost.op<{ stopping: true; live: number }>(
      descriptor, 'host.stop', { controllerLeaseId: lease.controllerLeaseId },
    )
    this.check(`host.stop reported no live runtimes left (${stopping.live})`, stopping.live === 0)
    await this.waitUntil(
      () => !existsSync(this.descriptorFile),
      'the descriptor outlived the Host it described',
    )
    this.check('the descriptor is gone once the Host has stopped', true)
    await this.waitUntil(
      () => this.hostExit !== null,
      'the packaged Host process was still running after host.stop',
    )
    this.check(`the packaged Host process ended (${this.hostExit})`, true)
  }

  private retire(): void {
    if (this.host !== null && this.host.exitCode === null) this.host.kill()
  }

  private static manifest(): HostBundleManifest {
    const file = join(SmokePackagedHost.bundleRootConst, 'manifest.json')
    if (!existsSync(file)) throw new Error(`the packaged bundle has no manifest at ${file}`)
    const root = SmokePackagedHost.recordOf(JSON.parse(readFileSync(file, 'utf8')), 'bundle manifest')
    const host = SmokePackagedHost.recordOf(root.host, 'bundle manifest host')
    const nodePty = SmokePackagedHost.recordOf(root.nodePty, 'bundle manifest nodePty')
    const runtime = SmokePackagedHost.recordOf(root.runtime, 'bundle manifest runtime')
    const tree = SmokePackagedHost.recordOf(root.tree, 'bundle manifest tree')
    if (root.schemaVersion !== 1 || typeof root.entry !== 'string'
      || typeof host.name !== 'string' || typeof host.version !== 'string'
      || typeof nodePty.version !== 'string'
      || typeof runtime.platform !== 'string' || typeof runtime.arch !== 'string'
      || typeof tree.files !== 'number' || !Number.isSafeInteger(tree.files) || tree.files < 1
      || typeof tree.sha256 !== 'string')
      throw new Error('the packaged bundle manifest fields are invalid')
    return {
      schemaVersion: 1,
      entry: root.entry,
      host: { name: host.name, version: host.version },
      nodePty: { version: nodePty.version },
      runtime: { platform: runtime.platform, arch: runtime.arch },
      tree: { files: tree.files, sha256: tree.sha256 },
    }
  }

  /** The same tree hash `scripts/release/prepare-host-bundle.ts` wrote, recomputed where it landed. */
  private static treeOf(root: string): HostBundleManifest['tree'] {
    const entries = SmokePackagedHost.filesUnder(root)
      .map((file) => ({
        path: SmokePackagedHost.relativePath(root, file),
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      }))
      .filter((entry) => entry.path !== 'manifest.json')
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
    const hash = createHash('sha256')
    for (const entry of entries)
      hash.update(entry.path, 'utf8').update('\0').update(entry.sha256, 'ascii').update('\n')
    return { files: entries.length, sha256: hash.digest('hex') }
  }

  private static filesUnder(directory: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) files.push(...SmokePackagedHost.filesUnder(path))
      else if (entry.isFile()) files.push(path)
      else throw new Error(`the packaged bundle contains an unsupported entry: ${path}`)
    }
    return files
  }

  private static relativePath(root: string, file: string): string {
    const child = relative(resolve(root), resolve(file))
    if (child.length === 0 || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child))
      throw new Error(`a packaged bundle file escapes its root: ${file}`)
    return child.split(sep).join('/')
  }

  /** What the PTY child gets. The Host inherits nothing into it, so it is composed here. */
  private static shellEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of ['SystemRoot', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
      'SystemDrive', 'windir', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
      const value = process.env[key]
      if (typeof value === 'string') env[key] = value
    }
    return env
  }

  private static async op<T>(
    descriptor: HostDescriptor,
    name: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/op/${name}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${descriptor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${name} answered ${response.status}: ${text}`)
    return JSON.parse(text) as T
  }

  private static connect(descriptor: HostDescriptor): Promise<WebSocket> {
    return new Promise((settle, fail) => {
      const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
      })
      socket.once('open', () => settle(socket))
      socket.once('error', fail)
    })
  }

  private static recordOf(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
  }

  private static discard(directory: string): void {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
    catch (error) {
      console.warn(`${SmokePackagedHost.labelConst} ${directory} could not be removed: ${
        error instanceof Error ? error.message : String(error)}`)
    }
  }
}

void SmokePackagedHost.run().catch((error: unknown) =>
  SmokeRun.failed('smoke-packaged-host', error))
