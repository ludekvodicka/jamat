import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VsCodeLauncher } from './vsCodeLauncher'

const spawned = vi.hoisted(() => ({
  calls: [] as { file: string; args: readonly string[]; options: Record<string, unknown> }[],
  listeners: new Map<string, ((error: Error) => void)[]>(),
  unrefs: 0,
}))

const filesystem = vi.hoisted(() => ({ present: new Set<string>() }))

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => {
    spawned.calls.push({ file, args, options })
    return {
      unref: () => { spawned.unrefs += 1 },
      on: (event: string, listener: (error: Error) => void) => {
        spawned.listeners.set(event, [...(spawned.listeners.get(event) ?? []), listener])
      },
    }
  },
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => filesystem.present.has(path.replace(/\//g, '\\')),
}))

describe('app-client-ui/app/terminals/vsCodeLauncher', () => {
  const platform = process.platform
  const path = process.env.PATH
  const installation = 'C:\\Program Files\\Microsoft VS Code'
  const reported: string[] = []

  function pretend(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  beforeEach(() => {
    spawned.calls.length = 0
    spawned.listeners.clear()
    spawned.unrefs = 0
    filesystem.present.clear()
    reported.length = 0
    pretend('win32')
    process.env.PATH = `C:\\Windows;${installation}\\bin`
    filesystem.present.add(`${installation}\\bin\\code.cmd`)
    filesystem.present.add(`${installation}\\Code.exe`)
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      reported.push(String(message))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    process.env.PATH = path
  })

  it('runs the executable beside the shim, never the shim itself', () => {
    VsCodeLauncher.open('C:\\a b\\deep\\file.ts', null)

    expect(spawned.calls).toHaveLength(1)
    expect(spawned.calls[0].file).toBe(`${installation}\\Code.exe`)
  })

  it('spells a line as -g beside the path, and the path stays one argument', () => {
    VsCodeLauncher.open('C:\\a b\\deep\\file.ts', 12)

    expect(spawned.calls[0].args).toEqual(['-g', 'C:\\a b\\deep\\file.ts:12'])
  })

  it('passes the bare path when there is no line, and when the line is not an integer', () => {
    VsCodeLauncher.open('C:\\p\\file.ts', null)
    VsCodeLauncher.open('C:\\p\\file.ts', 12.5)
    VsCodeLauncher.open('C:\\p\\file.ts', Number.NaN)

    for (const call of spawned.calls)
      expect(call.args).toEqual(['C:\\p\\file.ts'])
  })

  it('spawns detached and silent, without a shell, and lets go of the child', () => {
    VsCodeLauncher.open('C:\\p\\file.ts', null)

    const options = spawned.calls[0].options
    expect(options.detached).toBe(true)
    expect(options.stdio).toBe('ignore')
    expect(options.windowsHide).toBe(true)
    expect(options.shell).toBe(undefined)
    expect(spawned.unrefs).toBe(1)
  })

  /**
   * Without an environment of its own the child inherits the whole main process one, and a
   * development client's is electron-vite's. A VS Code opened here would then carry `NODE_ENV` and
   * `NODE_PATH` into every terminal opened inside IT, which is the leak twice over.
   */
  it('hands VS Code an environment with no Jamat variable and no dev runtime in it', () => {
    const previous = { ...process.env }
    process.env.NODE_ENV = 'development'
    process.env.NODE_PATH = 'Q:\\...\\electron-vite\\node_modules'
    process.env.JAMAT_V3_CONFIG_DIR = 'Q:\\v3'
    try {
      VsCodeLauncher.open('C:\\p\\file.ts', null)

      const env = spawned.calls[0].options.env as Record<string, string>
      expect(env.PATH).toBe(process.env.PATH)
      expect(env.NODE_ENV).toBeUndefined()
      expect(env.NODE_PATH).toBeUndefined()
      expect(env.JAMAT_V3_CONFIG_DIR).toBeUndefined()
    } finally {
      for (const key of ['NODE_ENV', 'NODE_PATH', 'JAMAT_V3_CONFIG_DIR']) {
        const was = previous[key]
        if (was === undefined) delete process.env[key]
        else process.env[key] = was
      }
    }
  })

  it('reports a machine with no VS Code instead of spawning anything', () => {
    filesystem.present.clear()

    VsCodeLauncher.open('C:\\p\\file.ts', null)

    expect(spawned.calls).toHaveLength(0)
    expect(reported).toEqual(['[app-client-ui] VS Code launch failed: no VS Code installation found on PATH'])
  })

  it('skips a shim whose executable is missing', () => {
    filesystem.present.delete(`${installation}\\Code.exe`)

    VsCodeLauncher.open('C:\\p\\file.ts', null)

    expect(spawned.calls).toHaveLength(0)
  })

  /*
   * A relative entry resolves against the main process working directory, so a `code.cmd` and a
   * `..\Code.exe` an unprivileged user can write there would be the first installation found.
   */
  it('never takes a shim off a relative PATH entry', () => {
    process.env.PATH = `.;${installation}\\bin`
    filesystem.present.add(join('.', 'code.cmd'))
    filesystem.present.add(resolve('.', '..', 'Code.exe'))

    VsCodeLauncher.open('C:\\p\\file.ts', null)

    expect(spawned.calls[0].file).toBe(`${installation}\\Code.exe`)

    process.env.PATH = '.'
    VsCodeLauncher.open('C:\\p\\file.ts', null)

    expect(spawned.calls).toHaveLength(1)
    expect(reported)
      .toEqual(['[app-client-ui] VS Code launch failed: no VS Code installation found on PATH'])
  })

  it('takes the plain command off PATH away from Windows', () => {
    pretend('linux')

    VsCodeLauncher.open('/home/u/p/file.ts', null)

    expect(spawned.calls[0].file).toBe('code')
  })

  it('reports a child that fails to start rather than throwing', () => {
    VsCodeLauncher.open('C:\\p\\file.ts', null)
    const listeners = spawned.listeners.get('error') ?? []

    expect(listeners).toHaveLength(1)
    expect(() => listeners[0](new Error('spawn Code.exe ENOENT'))).not.toThrow()
    expect(reported).toEqual(['[app-client-ui] VS Code launch failed: spawn Code.exe ENOENT'])
  })
})
