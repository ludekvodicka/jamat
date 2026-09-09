import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProcessStartIdentity } from '../shared/processStartIdentity.js'
import type { RuntimeLaunchSpec } from '../wire/hostWire.js'
import { TerminalInstance } from './terminalInstance.js'

const fakePty = vi.hoisted(() => ({
  killed: false,
  /** Whether `IPty.kill()` reports the death, which on Windows it frequently does not. */
  killEndsIt: false,
  reportExit: (exitCode: number): void => { void exitCode },
  hardKills: [] as string[][],
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 424_242,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: (event: { exitCode: number }) => void) => {
      fakePty.reportExit = (exitCode) => listener({ exitCode })
      return { dispose: () => undefined }
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      fakePty.killed = true
      if (fakePty.killEndsIt) fakePty.reportExit(0)
    },
  }),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], done: () => void) => {
      fakePty.hardKills.push([file, ...args])
      done()
    },
  }
})

describe('app-host/app/terminal/terminalInstance', () => {
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
      probe.mockRestore()
      instance.dispose()
    })

    /** A dead process is not retried into the deadline for nothing: it is refused the same way. */
    it('refuses a process the probe reports as already dead', async () => {
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

  it('kills the process tree when the pty kill does not confirm the death', async () => {
    const restorePlatform = TerminalInstanceTest.pinPlatform('win32')
    vi.useFakeTimers()
    const instance = TerminalInstanceTest.instance()

    const stopping = instance.stop()
    await vi.advanceTimersByTimeAsync(2_400)

    expect(fakePty.killed).toBe(true)
    expect(fakePty.hardKills).toEqual([['taskkill', '/PID', '424242', '/T', '/F']])
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
    fakePty.killEndsIt = false
    fakePty.reportExit = () => undefined
    fakePty.hardKills.length = 0
  }
}
