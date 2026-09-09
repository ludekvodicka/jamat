/**
 * Diagnostic, not a gate. Runs a REAL agent CLI through app-host and reports what the terminal
 * projection makes of it. The smoke test drives `cmd.exe`, whose output is a few plain lines; an
 * agent TUI uses the alternate screen buffer, heavy ANSI and constant redraw, which is the case that
 * would actually break the ring, the xterm-headless serialisation or the epoch/seq accounting.
 *
 * It is here rather than in scripts/smoke/ because it needs the agent installed and authenticated,
 * so it can never be a deterministic gate.
 *
 *   pnpm dev:probe-agent            # claude
 *   pnpm dev:probe-agent -- codex
 *
 * Anything after the agent name is passed to the CLI as it stands, which is how a launch flag gets
 * checked against a real PTY rather than against its own `--help`. The agent name is positional and
 * always first, so a flag alone would be read as one:
 *
 *   pnpm dev:probe-agent -- claude --model claude-fable-5
 *   pnpm dev:probe-agent -- codex -m gpt-5.6-sol
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'

import type {
  ControllerLeaseResult,
  HostDescriptor,
  HostWsServerMsg,
  RuntimeInspectResult,
  RuntimeRef,
  RuntimeResult,
} from '../../app-host/app/wire/hostWire.js'
import { ChildEnvironment } from '../../lib-orchestrator/shared/childEnvironment.js'

class ProbeAgent {
  private static readonly settleMsConst = 12_000
  private static readonly replyMsConst = 20_000

  static async run(): Promise<void> {
    const agent = process.argv[2] ?? 'claude'
    const agentArgs = process.argv.slice(3)
    const stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-probe-state-'))
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-probe-config-'))
    const workDir = mkdtempSync(join(tmpdir(), 'jamat-v3-probe-work-'))
    let host: ChildProcess | null = null
    try {
      host = ProbeAgent.spawnHost(stateRoot, configDir)
      const descriptor = await ProbeAgent.waitForDescriptor(stateRoot)
      const lease = await ProbeAgent.op<ControllerLeaseResult>(
        descriptor, 'controller.acquire', { controllerId: 'probe' },
      )
      // A lease expires (15s by default) and every mutation revalidates it, so a client that intends
      // to keep control has to renew. The renewal interval comes from the lease the Host handed back,
      // never from a constant here, or the two drift apart the moment the Host's TTL changes.
      const keepalive = ProbeAgent.keepLeaseAlive(descriptor, lease)

      console.log(`\n== spawning ${agent} in a PTY ==`)
      if (agentArgs.length > 0) console.log(`   with ${agentArgs.join(' ')}`)
      const created = await ProbeAgent.op<RuntimeResult>(descriptor, 'runtime.create', {
        controllerLeaseId: lease.controllerLeaseId,
        operationId: 'probe-1',
        runtimeSessionId: 'probe-agent',
        launch: {
          command: process.env.ComSpec ?? 'cmd.exe',
          args: ['/d', '/q', '/c', agent, ...agentArgs],
          cwd: workDir,
          env: ChildEnvironment.withoutJamat(process.env),
          cols: 120,
          rows: 34,
        },
      })
      const target: RuntimeRef = {
        hostInstanceId: created.hostInstanceId,
        runtimeSessionId: created.session.runtimeSessionId,
        generation: created.session.generation,
      }
      console.log(`   pid ${created.session.pid}, alive ${created.session.alive}`)

      console.log(`\n== letting it draw for ${ProbeAgent.settleMsConst / 1000}s ==`)
      await ProbeAgent.sleep(ProbeAgent.settleMsConst)
      const settled = await ProbeAgent.op<RuntimeInspectResult>(
        descriptor, 'runtime.inspect', { target },
      )
      ProbeAgent.report('after settle', settled)

      console.log('\n== attaching and sending a prompt ==')
      const socket = await ProbeAgent.connect(descriptor)
      const frames: HostWsServerMsg[] = []
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString('utf8')) as HostWsServerMsg)
      })
      socket.send(JSON.stringify({
        type: 'terminal.attach', target, controllerLeaseId: lease.controllerLeaseId,
        role: 'interactive',
      }))
      await ProbeAgent.waitFor(() => frames.some((f) => f.type === 'terminal.snapshot'),
        'no snapshot after attach')
      const snapshot = frames.find((f) => f.type === 'terminal.snapshot')
      if (snapshot?.type === 'terminal.snapshot')
        console.log(`   snapshot: raw ${snapshot.projection.raw.length} chars, `
          + `screen ${snapshot.projection.screen.length} chars, seq ${snapshot.projection.outputSeq}`)

      const before = frames.length
      socket.send(JSON.stringify({ type: 'terminal.input', data: 'say the word pineapple\r' }))
      const replied = await ProbeAgent.waitFor(
        () => frames.slice(before).some((f) => f.type === 'terminal.data'),
        'the agent produced no output after input',
        ProbeAgent.replyMsConst,
      ).then(() => true).catch(() => false)
      console.log(`   agent answered the input: ${replied}`)

      console.log('\n== resize while it is drawing ==')
      socket.send(JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 28 }))
      await ProbeAgent.sleep(2_000)
      const resized = await ProbeAgent.op<RuntimeInspectResult>(
        descriptor, 'runtime.inspect', { target },
      )
      ProbeAgent.report('after resize', resized)
      console.log(`   projection cols/rows: ${resized.projection?.cols}x${resized.projection?.rows}`)

      socket.close()
      await ProbeAgent.op(descriptor, 'runtime.stop', {
        controllerLeaseId: lease.controllerLeaseId, target,
      })
      clearInterval(keepalive)
      await ProbeAgent.op(descriptor, 'host.stop', {
        controllerLeaseId: lease.controllerLeaseId,
      })
      console.log('\n== stopped cleanly ==')
    } finally {
      if (host && host.exitCode === null) host.kill()
      for (const directory of [stateRoot, configDir, workDir])
        await ProbeAgent.removeWhenReleased(directory)
    }
  }

  /**
   * The agent's own children can still hold the work directory for a moment after the PTY dies, and
   * Windows answers EPERM rather than waiting. Cleanup of a temp directory is not worth failing the
   * probe over, so it retries briefly and then gives up quietly.
   */
  private static async removeWhenReleased(directory: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(directory, { recursive: true, force: true })
        return
      } catch {
        await ProbeAgent.sleep(300)
      }
    }
    console.log(`   (left behind, still locked: ${directory})`)
  }

  private static keepLeaseAlive(
    descriptor: HostDescriptor,
    lease: ControllerLeaseResult,
  ): ReturnType<typeof setInterval> {
    const lifetimeMs = Math.max(2_000, lease.expiresAt - Date.now())
    const timer = setInterval(() => {
      void ProbeAgent.op(descriptor, 'controller.renew', {
        controllerLeaseId: lease.controllerLeaseId,
      }).catch((error: unknown) => {
        console.log(`   lease renewal failed: ${
          error instanceof Error ? error.message : String(error)}`)
      })
    }, Math.floor(lifetimeMs / 2))
    timer.unref()
    return timer
  }

  private static report(label: string, inspected: RuntimeInspectResult): void {
    const projection = inspected.projection
    if (!projection) {
      console.log(`   ${label}: NO PROJECTION`)
      return
    }
    const raw = projection.raw
    const screen = projection.screen
    console.log(`   ${label}: alive ${inspected.session.alive}, seq ${projection.outputSeq}, `
      + `raw ${raw.length} chars, screen ${screen.length} chars`)
    console.log(`     ANSI escapes in raw: ${(raw.match(/\[/g) ?? []).length}`)
    console.log(`     alternate screen buffer used: ${raw.includes('[?1049h')}`)
    console.log(`     screen tail: ${JSON.stringify(screen.slice(-160))}`)
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

  private static async waitForDescriptor(stateRoot: string): Promise<HostDescriptor> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const found = ProbeAgent.findFile(stateRoot, 'descriptor.json')
      if (found) return JSON.parse(readFileSync(found, 'utf8')) as HostDescriptor
      await ProbeAgent.sleep(150)
    }
    throw new Error('the Host never published a descriptor')
  }

  private static findFile(directory: string, name: string): string | null {
    if (!existsSync(directory)) return null
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) {
        const nested = ProbeAgent.findFile(full, name)
        if (nested) return nested
      } else if (entry === name) return full
    }
    return null
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
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
      })
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  private static async waitFor(
    condition: () => boolean,
    failure: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (condition()) return
      await ProbeAgent.sleep(150)
    }
    throw new Error(failure)
  }

  private static sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
}

void ProbeAgent.run().catch((error) => {
  console.error(`probe-agent: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
