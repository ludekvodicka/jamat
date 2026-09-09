/**
 * End-to-end proof that app-host drives a real PTY: boot, create, inspect, attach, input, stop,
 * remove, host.stop. Unit tests use a fake terminal, so this is the only place a real node-pty child
 * is spawned and read back.
 *
 * Runs against an isolated state root and a temporary config directory, so it never touches the
 * machine's own %LOCALAPPDATA%\jamat-v3 or a Host the developer is using.
 *
 * The only import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import from app-host is its wire type surface: this script is a CLIENT of the API.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'

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

class SmokeHost extends SmokeHarness {
  private static readonly bootTimeoutMsConst = 30_000
  private static readonly frameTimeoutMsConst = 15_000
  /** The Host inherits nothing, so a working child environment has to be composed here (R8). */
  private static readonly envKeysConst = [
    'SystemRoot', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
    'SystemDrive', 'windir', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  ]
  private static passed = 0

  static async run(): Promise<void> {
    const stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-smoke-state-'))
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-smoke-config-'))
    let host: ChildProcess | null = null
    try {
      host = SmokeHost.spawnHost(stateRoot, configDir)
      const descriptorFile = await SmokeHost.waitForDescriptor(stateRoot)
      const descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8')) as HostDescriptor
      SmokeHost.check('descriptor schema is 1', descriptor.schemaVersion === 1)
      SmokeHost.check('wire major is 1', descriptor.protocol.major === 1)

      await SmokeHost.checkUnauthorized(descriptor)

      const lease = await SmokeHost.op<ControllerLeaseResult>(
        descriptor, 'controller.acquire', { controllerId: 'smoke' },
      )
      SmokeHost.check('controller lease acquired', typeof lease.controllerLeaseId === 'string')

      const created = await SmokeHost.op<RuntimeResult>(descriptor, 'runtime.create', {
        controllerLeaseId: lease.controllerLeaseId,
        operationId: 'smoke-1',
        runtimeSessionId: 'smoke-cli',
        launch: {
          command: process.env.ComSpec ?? 'cmd.exe',
          args: ['/d', '/q', '/k', 'echo ready'],
          cwd: configDir,
          env: SmokeHost.childEnv(),
          cols: 100,
          rows: 30,
        },
      })
      SmokeHost.check('runtime is alive', created.session.alive)
      const target: RuntimeRef = {
        hostInstanceId: created.hostInstanceId,
        runtimeSessionId: created.session.runtimeSessionId,
        generation: created.session.generation,
      }

      await SmokeHost.checkProjectionContains(descriptor, target, 'ready')
      await SmokeHost.checkAttachAndInput(descriptor, lease.controllerLeaseId, target)
      await SmokeHost.checkNotWriterAfterRelease(descriptor, lease.controllerLeaseId, target)

      const relet = await SmokeHost.op<ControllerLeaseResult>(
        descriptor, 'controller.acquire', { controllerId: 'smoke' },
      )
      const stopped = await SmokeHost.op<RuntimeMutationAck>(descriptor, 'runtime.stop', {
        controllerLeaseId: relet.controllerLeaseId,
        target,
      })
      SmokeHost.check(`stop acknowledged as stopped (${stopped.diagnostic})`,
        stopped.diagnostic === 'stopped')
      const removed = await SmokeHost.op<RuntimeMutationAck>(descriptor, 'runtime.remove', {
        controllerLeaseId: relet.controllerLeaseId,
        target,
      })
      SmokeHost.check(`remove acknowledged as removed (${removed.diagnostic})`,
        removed.diagnostic === 'removed')

      const stopping = await SmokeHost.op<{ stopping: true; live: number }>(
        descriptor, 'host.stop', { controllerLeaseId: relet.controllerLeaseId },
      )
      SmokeHost.check('host stop reported no live runtimes', stopping.live === 0)

      await SmokeHost.waitForGone(descriptorFile)
      SmokeHost.check('descriptor removed on shutdown', !existsSync(descriptorFile))
      SmokeHost.check('lock released on shutdown',
        !existsSync(join(descriptorFile, '..', 'host.lock')))

      console.log(`\nsmoke-host: ${SmokeHost.passed} checks passed`)
    } finally {
      if (host && host.exitCode === null) host.kill()
      rmSync(stateRoot, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  }

  private static spawnHost(stateRoot: string, configDir: string): ChildProcess {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join('app-host', 'start.ts'),
        '--config-dir', configDir, '--channel', 'development'],
      {
        env: { ...process.env, JAMAT_V3_LOCAL_STATE_DIR: stateRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`  host| ${chunk}`))
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`  host! ${chunk}`))
    return child
  }

  private static childEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of SmokeHost.envKeysConst) {
      const value = process.env[key]
      if (typeof value === 'string') env[key] = value
    }
    return env
  }

  private static async waitForDescriptor(stateRoot: string): Promise<string> {
    const deadline = Date.now() + SmokeHost.bootTimeoutMsConst
    while (Date.now() < deadline) {
      const found = SmokeHost.findFile(stateRoot, 'descriptor.json')
      if (found) return found
      await SmokeHarness.sleep(150)
    }
    throw new Error('the Host never published a descriptor')
  }

  private static findFile(directory: string, name: string): string | null {
    if (!existsSync(directory)) return null
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) {
        const nested = SmokeHost.findFile(full, name)
        if (nested) return nested
      } else if (entry === name) return full
    }
    return null
  }

  private static async waitForGone(file: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && existsSync(file)) await SmokeHarness.sleep(100)
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
    if (!response.ok)
      throw new Error(`${name} answered ${response.status}: ${text}`)
    return JSON.parse(text) as T
  }

  /** The token is the only thing between a loopback port and remote code execution. */
  private static async checkUnauthorized(descriptor: HostDescriptor): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/op/runtime.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    SmokeHost.check(`op without a token is refused (${response.status})`, response.status === 401)
  }

  private static async checkProjectionContains(
    descriptor: HostDescriptor,
    target: RuntimeRef,
    needle: string,
  ): Promise<void> {
    const deadline = Date.now() + SmokeHost.frameTimeoutMsConst
    while (Date.now() < deadline) {
      const inspected = await SmokeHost.op<RuntimeInspectResult>(
        descriptor, 'runtime.inspect', { target },
      )
      if (inspected.projection?.raw.includes(needle)) {
        SmokeHost.check(`projection captured ${JSON.stringify(needle)}`, true)
        return
      }
      await SmokeHarness.sleep(200)
    }
    throw new Error(`the projection never contained ${JSON.stringify(needle)}`)
  }

  private static async checkAttachAndInput(
    descriptor: HostDescriptor,
    controllerLeaseId: string,
    target: RuntimeRef,
  ): Promise<void> {
    const socket = await SmokeHost.connect(descriptor)
    try {
      const frames: HostWsServerMsg[] = []
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString('utf8')) as HostWsServerMsg)
      })
      socket.send(JSON.stringify({
        type: 'terminal.attach', target, controllerLeaseId, role: 'interactive',
      }))
      const attached = await SmokeHost.waitForFrame(frames, 'terminal.attached')
      SmokeHost.check('interactive attach is a writer',
        attached.type === 'terminal.attached' && attached.writer)
      await SmokeHost.waitForFrame(frames, 'terminal.snapshot')
      SmokeHost.check('attach delivered a snapshot', true)

      socket.send(JSON.stringify({ type: 'terminal.input', data: 'echo v3-smoke-marker\r' }))
      await SmokeHost.waitFor(
        () => frames.some((frame) => frame.type === 'terminal.data'
          && frame.delta.includes('v3-smoke-marker')),
        'the echoed input never came back as terminal.data',
      )
      SmokeHost.check('input reached the PTY and its output came back', true)
    } finally {
      socket.close()
    }
  }

  /** Releasing the lease must revoke the writer on the socket that is already attached. */
  private static async checkNotWriterAfterRelease(
    descriptor: HostDescriptor,
    controllerLeaseId: string,
    target: RuntimeRef,
  ): Promise<void> {
    const socket = await SmokeHost.connect(descriptor)
    try {
      const frames: HostWsServerMsg[] = []
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString('utf8')) as HostWsServerMsg)
      })
      socket.send(JSON.stringify({
        type: 'terminal.attach', target, controllerLeaseId, role: 'interactive',
      }))
      await SmokeHost.waitForFrame(frames, 'terminal.attached')
      await SmokeHost.op(descriptor, 'controller.release', { controllerLeaseId })
      socket.send(JSON.stringify({ type: 'terminal.input', data: 'must-not-write\r' }))
      await SmokeHost.waitFor(
        () => frames.some((frame) => frame.type === 'error' && frame.code === 'not-writer'),
        'input after controller.release was not refused with not-writer',
      )
      SmokeHost.check('input after lease release is refused as not-writer', true)
    } finally {
      socket.close()
    }
  }

  private static connect(descriptor: HostDescriptor): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
      })
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  private static async waitForFrame(
    frames: HostWsServerMsg[],
    type: HostWsServerMsg['type'],
  ): Promise<HostWsServerMsg> {
    await SmokeHost.waitFor(
      () => frames.some((frame) => frame.type === type),
      `the Host never sent ${type}`,
    )
    return frames.find((frame) => frame.type === type)!
  }

  private static async waitFor(condition: () => boolean, failure: string): Promise<void> {
    const deadline = Date.now() + SmokeHost.frameTimeoutMsConst
    while (Date.now() < deadline) {
      if (condition()) return
      await SmokeHarness.sleep(100)
    }
    throw new Error(failure)
  }

  private static check(description: string, condition: boolean): void {
    if (!condition) throw new Error(`FAILED: ${description}`)
    SmokeHost.passed += 1
    console.log(`  ok  ${description}`)
  }

}

void SmokeHost.run().catch((error: unknown) => SmokeRun.failed('smoke-host', error))
