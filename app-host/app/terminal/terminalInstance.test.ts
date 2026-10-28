import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProcessStartIdentity } from '../shared/processStartIdentity.js'
import type { RuntimeLaunchSpec } from '../wire/hostWire.js'
import { TerminalInstance } from './terminalInstance.js'
import { TerminalDescendants } from './terminalDescendants.js'
import { TerminalStopRefusal } from './terminalStopRefusal.js'

const fakePty = vi.hoisted(() => ({
  killed: false,
  kills: 0,
  /** Whether `IPty.kill()` reports the death, which on Windows it frequently does not. */
  killEndsIt: false,
  reportExit: (exitCode: number): void => { void exitCode },
  hardKills: [] as string[][],
  writes: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 424_242,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: (event: { exitCode: number }) => void) => {
      fakePty.reportExit = (exitCode) => listener({ exitCode })
      return { dispose: () => undefined }
    },
    write: (data: string) => { fakePty.writes.push(data) },
    resize: () => undefined,
    kill: () => {
      fakePty.killed = true
      fakePty.kills += 1
      if (fakePty.killEndsIt) fakePty.reportExit(0)
    },
  }),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], _options: unknown, done: () => void) => {
      fakePty.hardKills.push([file, ...args])
      done()
    },
  }
})

describe('app-host/app/terminal/terminalInstance', () => {
  it('requires explicit manual confirmation to clear an unknown tree after the root exits during inspection', async () => {
    vi.useFakeTimers()
    vi.spyOn(TerminalDescendants, 'capture').mockImplementation(async () => { fakePty.reportExit(0); throw new Error('Root disappeared') })
    vi.spyOn(TerminalDescendants, 'stop').mockResolvedValue()
    const instance = new TerminalInstance('managed', 1, 1, { ...TerminalInstanceTest.launch(), stopDescendants: true }, () => {})
    await expect(instance.stop()).rejects.toThrow('Root disappeared')
    await expect(instance.stop()).rejects.toThrow('Root disappeared')
    await expect(instance.stop(true)).resolves.toBeUndefined()
    await expect(instance.stop()).resolves.toBeUndefined()
    instance.dispose()
  })
  it('leaves the root alive after failed capture so a later Stop can capture and stop the whole tree', async () => {
    vi.useFakeTimers()
    const capture = vi.spyOn(TerminalDescendants, 'capture').mockRejectedValueOnce(new Error('CIM timed out')).mockResolvedValue([])
    fakePty.killEndsIt = true
    const instance = new TerminalInstance('managed', 1, 1, { ...TerminalInstanceTest.launch(), stopDescendants: true }, () => {})
    const outcome = instance.stop().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fakePty.killed).toBe(false)
    expect(instance.alive).toBe(true)
    expect(String(await outcome)).toContain('CIM timed out')
    const retried = instance.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await retried
    expect(capture).toHaveBeenCalledTimes(2)
    expect(instance.alive).toBe(false)
    instance.dispose()
  })
  it('UA1-J10-1: refuses a Stop whose inspection failed as a typed refusal that says to retry or to confirm by hand', async () => {
    vi.useFakeTimers()
    vi.spyOn(TerminalDescendants, 'capture').mockRejectedValueOnce(new Error('CIM timed out'))
      .mockImplementationOnce(async () => { fakePty.reportExit(1); throw new Error('Root disappeared') })
    vi.spyOn(TerminalDescendants, 'stop').mockResolvedValue()
    const instance = new TerminalInstance('managed', 1, 1, { ...TerminalInstanceTest.launch(), stopDescendants: true }, () => {})
    const live = await instance.stop().catch((error: unknown) => error)
    expect(live).toBeInstanceOf(TerminalStopRefusal)
    expect(String(live)).toContain('retry Stop')
    const ended = await instance.stop().catch((error: unknown) => error)
    expect(ended).toBeInstanceOf(TerminalStopRefusal)
    expect(String(ended)).toContain('confirm')
    expect(await instance.stop().catch((error: unknown) => error)).toBeInstanceOf(TerminalStopRefusal)
    instance.dispose()
  })
  it('keeps no failed inspection of a live root once that root ended by itself', async () => {
    vi.useFakeTimers()
    vi.spyOn(TerminalDescendants, 'capture').mockRejectedValueOnce(new Error('CIM timed out'))
    const stop = vi.spyOn(TerminalDescendants, 'stop').mockResolvedValue()
    const instance = new TerminalInstance('managed', 1, 1, { ...TerminalInstanceTest.launch(), stopDescendants: true }, () => {})
    await expect(instance.stop()).rejects.toThrow('CIM timed out')
    fakePty.reportExit(0)
    await expect(instance.stop()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledWith([])
    instance.dispose()
  })

  it('does not capture or kill descendants of an interactive terminal', async () => {
    vi.useFakeTimers()
    const capture = vi.spyOn(TerminalDescendants, 'capture')
    const stop = vi.spyOn(TerminalDescendants, 'stop')
    fakePty.killEndsIt = true
    const instance = TerminalInstanceTest.instance(), outcome = instance.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await outcome
    expect(capture).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    instance.dispose()
  })
  it('captures managed descendants before interrupting the shell and stops them after the shell exits', async () => {
    vi.useFakeTimers()
    const children = [{ pid: 1234, startedAt: 1000 }]
    const capture = vi.spyOn(TerminalDescendants, 'capture').mockImplementation(async () => { expect(fakePty.writes).toEqual([]); return children })
    const stopped = vi.spyOn(TerminalDescendants, 'stop').mockResolvedValue()
    const instance = new TerminalInstance('managed', 1, 1, { ...TerminalInstanceTest.launch(), stopDescendants: true }, () => {})
    const stopping = instance.stop()
    await vi.advanceTimersByTimeAsync(1)
    expect(capture).toHaveBeenCalled()
    fakePty.reportExit(0)
    await vi.advanceTimersByTimeAsync(500)
    await stopping
    expect(stopped).toHaveBeenCalledWith(children)
    instance.dispose()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    TerminalInstanceTest.reset()
  })

  it('waits for the start identity off the event loop', async () => {
    let attempts = 0
    const probe = vi.spyOn(ProcessStartIdentity, 'probeAsync')
      .mockImplementation(async () => {
        attempts += 1
        await new Promise((resolve) => { setImmediate(resolve) })
        return attempts < 2
          ? { state: 'unknown', reason: 'the process has no start time yet' }
          : { state: 'alive', processStartedAt: 1_700_000_000_000 }
      })
    const meanwhile: string[] = []
    const timer = setTimeout(() => meanwhile.push('the loop kept running'), 0)
    const instance = new TerminalInstance(
      'runtime-1',
      1,
      1,
      TerminalInstanceTest.launch(),
      () => undefined,
    )

    await instance.ready()

    expect(instance.processStartedAt).toBe(1_700_000_000_000)
    expect(attempts).toBe(2)
    expect(meanwhile).toEqual(['the loop kept running'])
    clearTimeout(timer)
    probe.mockRestore()
    instance.dispose()
  })

  describe('a spawn that never comes up', () => {
    /*
     * What a failed `sessions.create` looks like to a client, and the arms none of it reached: the
     * deadline expiring, the kill that follows it, and the reason of the LAST probe travelling into
     * the error. Driven on fake timers, because the deadline is five seconds of real ones.
     */
    it('kills the process and refuses, naming what the probe kept answering', async () => {
      vi.useFakeTimers()
      const probe = vi.spyOn(ProcessStartIdentity, 'probeAsync')
        .mockResolvedValue({ state: 'unknown', reason: 'the process has no start time yet' })
      const instance = TerminalInstanceTest.instance()

      const ready = instance.ready()
      const settled = ready.then(() => 'resolved').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(6_000)
      const outcome = await settled

      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toContain('did not expose a stable start identity')
      expect((outcome as Error).message).toContain('no start time yet')
      expect(fakePty.killed).toBe(true)
      expect(instance.exit).toBeNull()
      probe.mockRestore()
      instance.dispose()
    })

    /** Without the exit node-pty reports there is no exit code to answer, so it is refused the same way. */
    it('refuses a process the probe reports as dead when no exit is reported', async () => {
      vi.useFakeTimers()
      const probe = vi.spyOn(ProcessStartIdentity, 'probeAsync')
        .mockResolvedValue({ state: 'dead' })
      const instance = TerminalInstanceTest.instance()

      const settled = instance.ready().then(() => 'resolved').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(6_000)

      expect(await settled).toBeInstanceOf(Error)
      expect(fakePty.killed).toBe(true)
      probe.mockRestore()
      instance.dispose()
    })

    // The probe takes about half a second on Windows; `exit 0` is over before it answers.
    it('resolves with the exit of a process that ends before the probe sees it', async () => {
      vi.useFakeTimers()
      const probe = vi.spyOn(ProcessStartIdentity, 'probeAsync')
        .mockResolvedValue({ state: 'dead' })
      const instance = TerminalInstanceTest.instance()

      const settled = instance.ready().then(() => 'resolved').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      fakePty.reportExit(3)
      await vi.advanceTimersByTimeAsync(100)

      expect(await settled).toBe('resolved')
      expect(instance.alive).toBe(false)
      expect(instance.exit?.exitCode).toBe(3)
      expect(instance.info(1)).not.toHaveProperty('processStartedAt')
      // the release after the exit, never a refusal's kill
      expect(fakePty.kills).toBe(1)
      probe.mockRestore()
      instance.dispose()
    })

    it('resolves with the exit that lands while a probe still answers alive', async () => {
      const probe = vi.spyOn(ProcessStartIdentity, 'probeAsync')
        .mockImplementation(async () => {
          fakePty.reportExit(0)
          return { state: 'alive', processStartedAt: 1_700_000_000_000 }
        })
      const instance = TerminalInstanceTest.instance()

      await instance.ready()

      expect(instance.alive).toBe(false)
      expect(instance.exit?.exitCode).toBe(0)
      expect(instance.info(1)).not.toHaveProperty('pid')
      probe.mockRestore()
      instance.dispose()
    })

    // The Host is one process and the probe is another module's answer: a state this branch has
    // never heard of is a loud failure at the seam rather than a silent success.
    it('throws on a probe state it does not know instead of reading it as alive', async () => {
      vi.useFakeTimers()
      const probe = vi.spyOn(ProcessStartIdentity, 'probeAsync')
        .mockResolvedValue({ state: 'confused' } as unknown as { state: 'dead' })
      const instance = TerminalInstanceTest.instance()

      const settled = instance.ready().then(() => 'resolved').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)

      const outcome = await settled
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toContain('Unknown process identity probe')
      probe.mockRestore()
      instance.dispose()
    })
  })

  describe('releasing the pty', () => {
    // node-pty ends its Windows worker thread and the pseudoconsole only in kill().
    it('releases a process that ends by itself, once, also through a later dispose', () => {
      const instance = TerminalInstanceTest.instance()

      fakePty.reportExit(0)
      instance.dispose()

      expect(instance.exit?.exitCode).toBe(0)
      expect(fakePty.kills).toBe(1)
    })

    it('sends no second kill when the stop kill is what ends the process', async () => {
      vi.useFakeTimers()
      fakePty.killEndsIt = true
      const instance = TerminalInstanceTest.instance()

      const stopping = instance.stop()
      await vi.advanceTimersByTimeAsync(400)
      await stopping
      instance.dispose()

      expect(instance.alive).toBe(false)
      expect(fakePty.kills).toBe(1)
    })

    it('releases a live process on dispose', () => {
      const instance = TerminalInstanceTest.instance()

      instance.dispose()

      expect(fakePty.kills).toBe(1)
    })
  })

  it('kills the process tree when the pty kill does not confirm the death', async () => {
    const restorePlatform = TerminalInstanceTest.pinPlatform('win32')
    vi.useFakeTimers()
    const instance = TerminalInstanceTest.instance()

    const stopping = instance.stop()
    await vi.advanceTimersByTimeAsync(2_400)

    expect(fakePty.killed).toBe(true)
    expect(fakePty.hardKills).toEqual([['taskkill', '/PID', '424242', '/F']])
    fakePty.reportExit(1)
    await stopping
    expect(instance.alive).toBe(false)
    restorePlatform()
  })

  it('leaves the tree alone when the pty kill confirms the death', async () => {
    const restorePlatform = TerminalInstanceTest.pinPlatform('win32')
    vi.useFakeTimers()
    fakePty.killEndsIt = true
    const instance = TerminalInstanceTest.instance()

    const stopping = instance.stop()
    await vi.advanceTimersByTimeAsync(400)
    await stopping

    expect(instance.alive).toBe(false)
    expect(fakePty.hardKills).toEqual([])
    restorePlatform()
  })

  it('escalates with SIGKILL where there is no taskkill', async () => {
    const restorePlatform = TerminalInstanceTest.pinPlatform('linux')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.useFakeTimers()
    const instance = TerminalInstanceTest.instance()

    const stopping = instance.stop()
    await vi.advanceTimersByTimeAsync(2_400)

    expect(kill).toHaveBeenCalledWith(424_242, 'SIGKILL')
    expect(fakePty.hardKills).toEqual([])
    fakePty.reportExit(1)
    await stopping
    restorePlatform()
  })

  // The guard has to be released, or the retry a caller makes after an honest refusal is a no-op.
  it('stays alive and retryable when the process outlives every rung', async () => {
    const restorePlatform = TerminalInstanceTest.pinPlatform('win32')
    vi.useFakeTimers()
    const instance = TerminalInstanceTest.instance()

    const stopping = instance.stop()
    await vi.advanceTimersByTimeAsync(5_400)
    await stopping

    expect(instance.alive).toBe(true)
    const retry = instance.stop()
    await vi.advanceTimersByTimeAsync(5_400)
    await retry

    expect(fakePty.hardKills).toHaveLength(2)
    restorePlatform()
  })
})

class TerminalInstanceTest {
  static launch(): RuntimeLaunchSpec {
    return {
      command: 'fake',
      args: [],
      cwd: process.cwd(),
      env: {},
      cols: 80,
      rows: 24,
    }
  }

  static instance(): TerminalInstance {
    return new TerminalInstance('runtime-1', 1, 1, TerminalInstanceTest.launch(), () => undefined)
  }

  /** The escalation is one branch per platform, so each is tested where it actually runs. */
  static pinPlatform(value: NodeJS.Platform): () => void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value, configurable: true })
    return () => {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  }

  static reset(): void {
    fakePty.killed = false
    fakePty.kills = 0
    fakePty.killEndsIt = false
    fakePty.reportExit = () => undefined
    fakePty.hardKills.length = 0
    fakePty.writes.length = 0
  }
}
