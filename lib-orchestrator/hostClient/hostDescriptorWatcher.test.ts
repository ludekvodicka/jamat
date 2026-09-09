import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import { HostDescriptorWatcher } from './hostDescriptorWatcher'

describe('lib-orchestrator/hostClient/hostDescriptorWatcher', () => {
  const created: string[] = []
  const watchers: HostDescriptorWatcher[] = []

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.stop()
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    file: string
    changes: (HostDescriptor | null)[]
    errors: string[]
    watcher: HostDescriptorWatcher
    write: (content: unknown) => void
  }

  function harness(pollMilliseconds?: number): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-descriptor-watch-'))
    created.push(root)
    const file = join(root, 'descriptor.json')
    const changes: (HostDescriptor | null)[] = []
    const errors: string[] = []
    const watcher = new HostDescriptorWatcher({
      descriptorFile: file,
      pollMilliseconds,
      onChange: (descriptor) => changes.push(descriptor),
      onError: (message) => errors.push(message),
    })
    watchers.push(watcher)
    return {
      file,
      changes,
      errors,
      watcher,
      write: (content) => writeFileSync(
        file,
        typeof content === 'string' ? content : JSON.stringify(content),
        'utf8',
      ),
    }
  }

  function descriptor(overrides?: Partial<HostDescriptor>): HostDescriptor {
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
      ...overrides,
    }
  }

  it('reports nothing and no error while no Host has ever published', async () => {
    const context = harness()
    await context.watcher.read()
    expect(context.watcher.current()).toBeNull()
    expect(context.changes).toEqual([])
    expect(context.errors).toEqual([])
  })

  it('announces a descriptor once and stays quiet while it does not change', async () => {
    const context = harness()
    context.write(descriptor())
    await context.watcher.read()
    await context.watcher.read()
    await context.watcher.read()
    expect(context.changes).toHaveLength(1)
    expect(context.watcher.current()?.hostInstanceId).toBe('host-1')
  })

  it('announces the disappearance once, and the return of another Host', async () => {
    const context = harness()
    context.write(descriptor())
    await context.watcher.read()
    unlinkSync(context.file)
    await context.watcher.read()
    await context.watcher.read()
    expect(context.changes).toEqual([expect.anything(), null])
    expect(context.watcher.current()).toBeNull()

    context.write(descriptor({ hostInstanceId: 'host-2', port: 4322, token: 'token-b' }))
    await context.watcher.read()
    expect(context.changes).toHaveLength(3)
    expect(context.watcher.current()?.hostInstanceId).toBe('host-2')
    expect(context.errors).toEqual([])
  })

  it('treats a damaged file as no Host, says so once, and never throws', async () => {
    const context = harness()
    context.write('{ not json at all')
    await context.watcher.read()
    await context.watcher.read()
    expect(context.watcher.current()).toBeNull()
    expect(context.changes).toEqual([])
    expect(context.errors).toHaveLength(1)
    expect(context.errors[0]).toContain('is not JSON')
  })

  // A descriptor of a schema this client does not know is not something to read half of: the port
  // and the token in it may mean something else entirely.
  it('treats an unsupported schema version and a missing port as damage', async () => {
    const context = harness()
    context.write({ ...descriptor(), schemaVersion: 2 })
    await context.watcher.read()
    expect(context.errors[0]).toContain('unsupported schema version')

    const second = harness()
    second.write({ ...descriptor(), port: 0 })
    await second.watcher.read()
    expect(second.errors[0]).toContain('no usable port')
    expect(second.watcher.current()).toBeNull()
  })

  it('says it again once the file is damaged in a new way', async () => {
    const context = harness()
    context.write('{ not json at all')
    await context.watcher.read()
    context.write('{ broken differently')
    await context.watcher.read()
    expect(context.errors).toHaveLength(2)
  })

  it('polls on a timer once started', async () => {
    const context = harness(10)
    context.watcher.start()
    context.write(descriptor())
    await vi.waitFor(() => expect(context.watcher.current()?.port).toBe(4321), { timeout: 2_000 })
    unlinkSync(context.file)
    await vi.waitFor(() => expect(context.watcher.current()).toBeNull(), { timeout: 2_000 })
  })

  /*
   * The poll has no caller. `onChange` runs the client's whole reaction to a Host appearing - the
   * session manager recomposes its snapshot in there, and that composition throws on purpose in
   * several places - twice a second, so a throw escaping it must reach the error channel instead of
   * becoming an unhandled rejection that takes the client's main process down with it.
   */
  it('reports what escapes onChange instead of rejecting into the process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-descriptor-watch-'))
    created.push(root)
    const file = join(root, 'descriptor.json')
    writeFileSync(file, JSON.stringify(descriptor()), 'utf8')
    const errors: string[] = []
    const watcher = new HostDescriptorWatcher({
      descriptorFile: file,
      pollMilliseconds: 10,
      onChange: () => { throw new Error('the client could not take the news') },
      onError: (message) => errors.push(message),
    })
    watchers.push(watcher)

    watcher.start()
    await vi.waitFor(() => expect(errors).not.toHaveLength(0), { timeout: 2_000 })
    expect(errors[0]).toContain('the client could not take the news')
  })
})
