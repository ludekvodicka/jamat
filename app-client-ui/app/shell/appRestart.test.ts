import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AppRestart, type AppRestartDeps } from './appRestart'

class FakeChild extends EventEmitter {
  unrefCalls = 0
  unref(): void { this.unrefCalls += 1 }
}

interface Harness {
  restarter: AppRestart
  child: FakeChild
  spawns: { command: string; args: string[]; options: Record<string, unknown> }[]
  reports: string[]
  counters: { relaunch: number; quit: number }
  logFile: string
}

describe('app-client-ui/app/shell/appRestart', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const directory of tempDirs.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function build(overrides: Partial<AppRestartDeps> = {}): Harness {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-app-restart-'))
    tempDirs.push(directory)
    const logFile = join(directory, 'restart-dev.log')
    const child = new FakeChild()
    const spawns: Harness['spawns'] = []
    const reports: string[] = []
    const counters = { relaunch: 0, quit: 0 }
    const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
      spawns.push({ command, args, options })
      return child
    }) as unknown as AppRestartDeps['spawnImpl']
    const restarter = new AppRestart({
      devRendererUrl: 'http://localhost:5173',
      packageDir: 'Q:/tree/app-client-ui',
      logFile,
      report: (message) => reports.push(message),
      relaunch: () => { counters.relaunch += 1 },
      quit: () => { counters.quit += 1 },
      spawnImpl,
      graceMilliseconds: 5,
      ...overrides,
    })
    return { restarter, child, spawns, reports, counters, logFile }
  }

  it('respawns the dev pipeline detached into the log file and quits', async () => {
    const harness = build()
    await harness.restarter.restart()
    expect(harness.spawns).toHaveLength(1)
    const [spawned] = harness.spawns
    // Plain node running electron-vite's bin: a cmd/pnpm chain pops console windows once the
    // detached parent has none, and Electron-as-Node makes rollup's native addon load slowly with
    // the Windows hard-error chime.
    expect(spawned.command).toBe('node')
    expect(spawned.args).toEqual([
      join('Q:/tree/app-client-ui', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'dev',
    ])
    expect(spawned.options.cwd).toBe('Q:/tree/app-client-ui')
    expect(spawned.options.shell).toBeUndefined()
    expect(spawned.options.detached).toBe(true)
    expect(spawned.options.windowsHide).toBe(true)
    expect(harness.child.unrefCalls).toBe(1)
    expect(existsSync(harness.logFile)).toBe(true)
    expect(harness.counters).toEqual({ relaunch: 0, quit: 1 })
    expect(harness.reports).toEqual([])
  })

  it('stays alive and reports when the pipeline dies inside the grace', async () => {
    const harness = build()
    const done = harness.restarter.restart()
    harness.child.emit('exit', 1, null)
    await done
    expect(harness.counters.quit).toBe(0)
    expect(harness.reports).toHaveLength(1)
    expect(harness.reports[0]).toContain('exited with code 1')
    expect(harness.reports[0]).toContain(harness.logFile)
  })

  it('stays alive and reports when the spawn itself errors', async () => {
    const harness = build()
    const done = harness.restarter.restart()
    harness.child.emit('error', new Error('spawn pnpm ENOENT'))
    await done
    expect(harness.counters.quit).toBe(0)
    expect(harness.reports).toHaveLength(1)
    expect(harness.reports[0]).toContain('spawn pnpm ENOENT')
  })

  it('reports an unwritable log file instead of quitting', async () => {
    const harness = build({ logFile: join('Q:/does-not-exist-anywhere', 'restart-dev.log') })
    await harness.restarter.restart()
    expect(harness.spawns).toHaveLength(0)
    expect(harness.counters.quit).toBe(0)
    expect(harness.reports).toHaveLength(1)
    expect(harness.reports[0]).toContain('cannot open')
  })

  it('relaunches the executable outside the dev pipeline', async () => {
    const harness = build({ devRendererUrl: undefined })
    await harness.restarter.restart()
    expect(harness.spawns).toHaveLength(0)
    expect(harness.counters).toEqual({ relaunch: 1, quit: 1 })
    expect(harness.reports).toEqual([])
  })
})
