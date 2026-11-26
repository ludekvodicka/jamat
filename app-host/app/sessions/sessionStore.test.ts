import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import { SessionStore } from './sessionStore.js'

const spawned = vi.hoisted(() => ({ files: [] as string[] }))

/*
 * The dump is written on every resize and every operation, on the main thread, and it used to end
 * in two `icacls.exe` runs per call. This mock covers THIS file's module graph - the store and the
 * atomic writer under it - which is the write path that matters; the guard used to sit beside the
 * writer alone, where nothing it could catch is ever driven.
 */
vi.mock('node:child_process', () => ({
  spawn: (file: string) => {
    spawned.files.push(file)
    throw new Error(`unexpected spawn of ${file}`)
  },
  spawnSync: (file: string) => {
    spawned.files.push(file)
    return { status: 0, stdout: '', stderr: '' }
  },
}))

describe('app-host/app/sessions/sessionStore', () => {
  const directories: string[] = []

  afterEach(() => {
    spawned.files.length = 0
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  // Reading a dump back would let a recorded answer outlive the PTYs it described.
  it('starts empty when a diagnostic dump already exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-store-'))
    directories.push(directory)
    const file = join(directory, 'host-state.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      savedAt: 1,
      sessions: {
        stale: {
          runtimeSessionId: 'stale',
          generation: 1,
          alive: true,
        },
      },
      operations: {},
    }))

    const store = new SessionStore(file, () => undefined)

    expect(store.list()).toEqual([])
  })

  it('drops the oldest operation once the ledger is full and answers the rest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-ledger-'))
    directories.push(directory)
    const writeAsync = vi.spyOn(AtomicJsonFile, 'writeAsync').mockResolvedValue(undefined)
    const writeSync = vi.spyOn(AtomicJsonFile, 'write')
    const store = new SessionStore(join(directory, 'host-state.json'), () => undefined)

    for (let index = 0; index <= 1_000; index++)
      store.recordOperation(`operation-${index}`, {
        kind: 'create',
        requestKey: `key-${index}`,
        target: {
          hostInstanceId: 'host-1',
          runtimeSessionId: `runtime-${index}`,
          generation: 1,
        },
      })

    await store.drain()
    expect(writeSync).not.toHaveBeenCalled()
    expect(writeAsync).toHaveBeenCalledTimes(1)
    expect(store.operation('operation-0', 'create', 'key-0')).toBeUndefined()
    expect(store.operation('operation-1', 'create', 'key-1'))
      .toMatchObject({ requestKey: 'key-1' })
    expect(store.operation('operation-1000', 'create', 'key-1000'))
      .toMatchObject({ requestKey: 'key-1000' })
    writeSync.mockRestore()
    writeAsync.mockRestore()
  })

  it('writes its dump asynchronously without spawning anything and coalesces bursts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-spawn-'))
    directories.push(directory)
    const file = join(directory, 'host-state.json')
    const writeSync = vi.spyOn(AtomicJsonFile, 'write')
    const store = new SessionStore(file, () => undefined)

    store.upsert({
      runtimeSessionId: 'runtime-1',
      generation: 1,
      alive: true,
      cols: 80,
      rows: 24,
      startedAt: 1,
      lastOutputAt: 1,
      outputSeq: 0,
      outputEpoch: 1,
    })
    store.remove('runtime-1')
    await store.drain()

    expect(writeSync).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toEqual({})
    expect(spawned.files).toEqual([])
    writeSync.mockRestore()
  })

  it('coalesces mutations arriving during an in-flight write and reports write errors via onWarn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-host-coalesce-'))
    directories.push(directory)
    const file = join(directory, 'host-state.json')
    const warnings: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const writtenSnapshots: Record<string, unknown>[] = []
    let call = 0
    const writeAsync = vi.spyOn(AtomicJsonFile, 'writeAsync').mockImplementation(async (_target, value) => {
      call += 1
      writtenSnapshots.push(value as Record<string, unknown>)
      if (call === 1) await firstGate
      if (call === 2) throw new Error('disk full')
    })

    const store = new SessionStore(file, (message) => warnings.push(message))
    const session = (id: string, cols: number) => ({
      runtimeSessionId: id,
      generation: 1,
      alive: true,
      cols,
      rows: 24,
      startedAt: 1,
      lastOutputAt: 1,
      outputSeq: 0,
      outputEpoch: 1,
    })

    store.upsert(session('s-1', 80))
    await vi.waitFor(() => expect(call).toBe(1))
    // Arrive while write #1 is in flight: should coalesce into one write (#2).
    store.upsert(session('s-1', 100))
    store.upsert(session('s-1', 120))
    releaseFirst()
    await store.drain()

    expect(call).toBe(2)
    expect((writtenSnapshots[1] as { sessions: Record<string, { cols: number }> }).sessions['s-1']?.cols).toBe(120)
    expect(warnings).toEqual(['Host diagnostics dump could not be written: disk full'])

    // Recovery after an error: next mutation still writes cleanly.
    store.upsert(session('s-1', 140))
    await store.drain()
    expect(call).toBe(3)
    expect((writtenSnapshots[2] as { sessions: Record<string, { cols: number }> }).sessions['s-1']?.cols).toBe(140)
    writeAsync.mockRestore()
  })
})
