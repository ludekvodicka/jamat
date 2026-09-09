import type { spawn, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import type { HostConnectionPresence } from '../hostClient/hostClient.types'
import { HostController, type HostControllerDeps } from './hostController'

describe('lib-orchestrator/hostControl/hostController', () => {
  /**
   * Nowhere near this file, so a root that is measured instead of injected cannot pass for it, and it
   * carries the entry point, because a root without one is now refused before anything is spawned.
   */
  const applicationRootConst = mkdtempSync(join(tmpdir(), 'jamat-v3-host-controller-'))
  /** What a packaged client stands in: a directory that exists and holds no `app-host`. */
  const packagedRootConst = mkdtempSync(join(tmpdir(), 'jamat-v3-host-controller-packaged-'))

  mkdirSync(join(applicationRootConst, 'app-host'), { recursive: true })
  writeFileSync(join(applicationRootConst, 'app-host', 'start.ts'), '')

  afterAll(() => {
    rmSync(applicationRootConst, { recursive: true, force: true })
    rmSync(packagedRootConst, { recursive: true, force: true })
  })

  class FakeChild extends EventEmitter {
    unrefCalls = 0

    unref(): this {
      this.unrefCalls += 1
      return this
    }
  }

  interface SpawnCall {
    command: string
    args: readonly string[]
    options: SpawnOptions
  }

  interface Fixture {
    presence: HostConnectionPresence
    descriptor: HostDescriptor | null
    throwOnSpawn: Error | null
    onSpawn: (child: FakeChild) => void
  }

  interface Harness {
    controller: HostController
    calls: SpawnCall[]
    children: FakeChild[]
    errors: string[]
    fixture: Fixture
  }

  function harness(overrides?: Partial<HostControllerDeps>): Harness {
    const calls: SpawnCall[] = []
    const children: FakeChild[] = []
    const errors: string[] = []
    const fixture: Fixture = {
      presence: 'unreachable',
      descriptor: null,
      throwOnSpawn: null,
      onSpawn: () => {},
    }
    const spawnImpl = ((command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, args, options })
      if (fixture.throwOnSpawn !== null) throw fixture.throwOnSpawn
      const child = new FakeChild()
      children.push(child)
      fixture.onSpawn(child)
      return child
    }) as unknown as typeof spawn
    const controller = new HostController({
      applicationRoot: applicationRootConst,
      // Not a packaged client: the source entry under the root above is the only place to look.
      resourcesRoot: null,
      configDir: join('C:', 'tmp', 'config'),
      channel: 'development',
      presenceOf: () => fixture.presence,
      descriptorOf: () => fixture.descriptor,
      onError: (message) => errors.push(message),
      spawnImpl,
      bootTimeoutMilliseconds: 200,
      presencePollMilliseconds: 5,
      ...overrides,
    })
    return { controller, calls, children, errors, fixture }
  }

  function descriptor(): HostDescriptor {
    return {
      schemaVersion: 1,
      pid: 10,
      processStartedAt: 1,
      port: 4321,
      token: 'token-a',
      protocol: { major: 1, minor: 0 },
      capabilities: [],
      hostVersion: '1.2.3',
      payloadHash: 'hash',
      configIdentity: 'identity-a',
      runtimeChannel: 'development',
      hostInstanceId: 'host-1',
      hostGeneration: 'generation-1',
      startedAt: 1,
    }
  }

  it('refuses to start a Host that is already running, and spawns nothing', async () => {
    const context = harness()
    context.fixture.presence = 'running'

    const result = await context.controller.start()
    expect(result).toEqual({ ok: false, code: 'already-running', detail: expect.any(String) })
    expect(context.calls).toEqual([])
    expect(context.controller.lastStartError()).toBeNull()
    expect(context.errors).toEqual([])
  })

  it('spawns the Host detached, unreferenced and away from the client stdio', async () => {
    const context = harness()
    context.fixture.onSpawn = () => {
      context.fixture.presence = 'running'
    }

    expect(await context.controller.start()).toEqual({ ok: true })
    expect(context.calls).toHaveLength(1)
    expect(context.calls[0].command).toBe(process.execPath)
    expect(context.calls[0].args).toContain('--config-dir')
    expect(context.calls[0].args[context.calls[0].args.indexOf('--channel') + 1]).toBe('development')
    expect(context.calls[0].options.detached).toBe(true)
    expect(context.calls[0].options.stdio).toBe('ignore')
    expect(context.children[0].unrefCalls).toBe(1)
  })

  /**
   * The entry point has to come from the root the client named. It used to be arithmetic on the
   * module's own URL, which in the bundled client resolves inside `app-client-ui` - where no
   * `app-host` stands - and no assertion comparing that path against the cwd derived from the very
   * same arithmetic could ever fail.
   */
  it('launches the entry point under the application root it was given', async () => {
    const context = harness()
    context.fixture.onSpawn = () => {
      context.fixture.presence = 'running'
    }

    expect(await context.controller.start()).toEqual({ ok: true })
    expect(context.calls[0].args[2]).toBe(join(applicationRootConst, 'app-host', 'start.ts'))
    expect(context.calls[0].options.cwd).toBe(applicationRootConst)
  })

  /**
   * The packaged client, which is the case the boot deadline used to be spent on: `resources` holds
   * no `app-host`, the spawn of a script that is not there succeeds anyway, the child dies at once
   * and the user waited fifteen seconds for an exit code. The boot timeout here is a minute, so a
   * launch that still went through the wait could not answer inside the elapsed assertion.
   */
  it('refuses a root with no entry point at once, spawning nothing and waiting for nothing', async () => {
    const context = harness({
      applicationRoot: packagedRootConst,
      bootTimeoutMilliseconds: 60_000,
    })

    const startedAt = Date.now()
    const result = await context.controller.start()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({ code: 'spawn-failed' })
    expect(context.calls).toEqual([])
    expect(context.controller.lastStartError())
      .toContain(join(packagedRootConst, 'app-host', 'start.ts'))
    expect(context.errors).toEqual([context.controller.lastStartError()])
  })

  /**
   * `process.execPath` in the client is `electron.exe`, which runs a Node entry point only under
   * this switch. The environment is otherwise this process's own, because that is what tells the
   * Host which state root it is meant to serve.
   */
  it('spawns the Host with an environment that runs Node and names the state root', async () => {
    const previous = process.env.JAMAT_V3_LOCAL_STATE_DIR
    const stateRoot = join('C:', 'tmp', 'state-a')
    process.env.JAMAT_V3_LOCAL_STATE_DIR = stateRoot
    try {
      const context = harness()
      context.fixture.onSpawn = () => {
        context.fixture.presence = 'running'
      }

      expect(await context.controller.start()).toEqual({ ok: true })
      const env = context.calls[0].options.env ?? {}
      expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(env.JAMAT_V3_LOCAL_STATE_DIR).toBe(stateRoot)
    } finally {
      if (previous === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
      else process.env.JAMAT_V3_LOCAL_STATE_DIR = previous
    }
  })

  it('reports a spawn that throws as spawn-failed and remembers why', async () => {
    const context = harness()
    context.fixture.throwOnSpawn = new Error('EINVAL: the command is not runnable')

    const result = await context.controller.start()
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ code: 'spawn-failed' })
    expect(context.controller.lastStartError()).toContain('EINVAL')
    expect(context.errors).toEqual([context.controller.lastStartError()])
  })

  // Node does not throw for a missing executable, it says so on the child a tick later.
  it('reports a child that never starts as spawn-failed', async () => {
    const context = harness()
    context.fixture.onSpawn = (child) => {
      setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0)
    }

    const result = await context.controller.start()
    expect(result).toMatchObject({ code: 'spawn-failed' })
    expect(context.controller.lastStartError()).toContain('ENOENT')
  })

  it('gives up with boot-timeout when no Host answers, and says how the process ended', async () => {
    const context = harness()
    context.fixture.onSpawn = (child) => {
      setTimeout(() => child.emit('exit', 1, null), 0)
    }

    const result = await context.controller.start()
    expect(result).toMatchObject({ code: 'boot-timeout' })
    expect(context.controller.lastStartError()).toContain('exited with code 1')
    expect(context.errors).toHaveLength(1)
  })

  // Two clients starting at once is ordinary: the Host's own process lock refuses the loser, and the
  // descriptor the winner published is exactly what this call asked for.
  it('takes a Host that appeared during the spawn as success, losing the race and all', async () => {
    const context = harness()
    context.fixture.onSpawn = (child) => {
      context.fixture.presence = 'running'
      setTimeout(() => child.emit('exit', 1, null), 0)
    }

    expect(await context.controller.start()).toEqual({ ok: true })
    expect(context.calls).toHaveLength(1)
    expect(context.controller.lastStartError()).toBeNull()
    expect(context.errors).toEqual([])
  })

  it('waits through polls for a Host that takes its time to answer', async () => {
    const context = harness()
    context.fixture.onSpawn = () => {
      setTimeout(() => {
        context.fixture.presence = 'running'
      }, 30)
    }

    expect(await context.controller.start()).toEqual({ ok: true })
  })

  it('refuses a second start while the first is still in flight', async () => {
    const context = harness()

    const first = context.controller.start()
    const second = await context.controller.start()
    expect(second).toMatchObject({ code: 'already-running' })
    context.fixture.presence = 'running'

    expect(await first).toEqual({ ok: true })
    expect(context.calls).toHaveLength(1)
    expect(context.controller.lastStartError()).toBeNull()
  })

  it('calls itself starting only while a launch is in flight', async () => {
    const context = harness()
    expect(context.controller.presence()).toBe('unreachable')

    const running = context.controller.start()
    expect(context.controller.presence()).toBe('starting')
    context.fixture.presence = 'running'
    expect(context.controller.presence()).toBe('running')

    await running
    expect(context.controller.presence()).toBe('running')
  })

  it('tries once for the life of the client, however it went', async () => {
    const context = harness()
    context.fixture.throwOnSpawn = new Error('EINVAL: the command is not runnable')

    await context.controller.ensureRunningOnce()
    await context.controller.ensureRunningOnce()
    expect(context.calls).toHaveLength(1)
    expect(context.errors).toHaveLength(1)
  })

  it('spawns nothing automatically when a Host is already running', async () => {
    const context = harness()
    context.fixture.presence = 'running'

    await context.controller.ensureRunningOnce()
    expect(context.calls).toEqual([])
    expect(context.errors).toEqual([])
    expect(context.controller.lastStartError()).toBeNull()
  })

  it('forgets the last failure once a start succeeds', async () => {
    const context = harness()
    await context.controller.start()
    expect(context.controller.lastStartError()).not.toBeNull()

    context.fixture.onSpawn = () => {
      context.fixture.presence = 'running'
    }
    expect(await context.controller.start()).toEqual({ ok: true })
    expect(context.controller.lastStartError()).toBeNull()
  })

  it('reads the Host version and instance from the descriptor, and nothing from none', () => {
    const context = harness()
    expect(context.controller.hostVersion()).toBeNull()
    expect(context.controller.hostInstanceId()).toBeNull()

    context.fixture.descriptor = descriptor()
    expect(context.controller.hostVersion()).toBe('1.2.3')
    expect(context.controller.hostInstanceId()).toBe('host-1')
  })

  // Presence says `starting`; what is behind it - a spawn in flight, the one automatic attempt
  // spent, and what the last one said - is only ever read by the debug surface.
  it('shows the launch state behind presence, a spawn in flight included', async () => {
    const context = harness()
    expect(context.controller.debugView()).toEqual({
      launching: false,
      autoStartAttempted: false,
      lastStartError: null,
    })

    const launching = context.controller.ensureRunningOnce()
    expect(context.controller.debugView().launching).toBe(true)
    await launching

    const settled = context.controller.debugView()
    expect(settled.launching).toBe(false)
    expect(settled.autoStartAttempted).toBe(true)
    expect(settled.lastStartError).toBe(context.controller.lastStartError())
    expect(settled.lastStartError).not.toBeNull()
  })

  // `host.stop` kills every PTY the Host owns. Closing a client detaches, so this class must not
  // grow a way to do it, private or public.
  it('offers no way to stop the Host', () => {
    const names = Object.getOwnPropertyNames(HostController.prototype)
    expect(names.filter((name) => name.toLowerCase().includes('stop'))).toEqual([])
  })
})
