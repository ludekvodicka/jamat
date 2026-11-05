import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { FileViewerMediaView } from '../../../lib-orchestrator/fileViewer/fileViewerMediaView'
import { LocalFileMediaSource } from '../fileViewer/localFileMediaSource'
import { describe, expect, it, vi } from 'vitest'
import { OrchestratorApiClient } from './orchestratorApiClient'
import { ShellPortClient } from '../../../app-orchestrator/app/ports/shellPortClient'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { ShellPort } from '../../../lib-orchestrator/shared/shellPort.types'
import type { ShellSnapshot } from '../../../lib-orchestrator/clientApi/orchestratorProcess.types'
import { UiSettings } from '../../shared/uiSettings'

describe('native orchestration client', () => {
  function fixture() {
    const snapshot: ShellSnapshot = { groups: [], panels: [], lastFocusedWindowId: null }
    let notice!: Parameters<ShellPort['onNotice']>[0]
    let groups!: Parameters<ShellPort['sessionGroups']['onChanged']>[0]
    const unsubscribed = vi.fn(), event = vi.fn(), invoked = vi.fn(async (_target: string, _method: string, _args: unknown[]): Promise<unknown> => ({ ok: true, path: 'verified' })), notices = vi.fn()
    const assign = vi.fn<ShellPort['sessionGroups']['assign']>(async () => ({ ok: true, assignments: snapshot.groups }))
    const shell = { onNotice: (listener: typeof notice) => { notice = listener; return unsubscribed },
      sessionGroups: { onChanged: (listener: typeof groups) => { groups = listener; return unsubscribed },
        assignments: () => snapshot.groups, assign },
      cipher: { available: async () => true, encrypt: async (text: string) => Buffer.from(text),
        decrypt: async (bytes: Uint8Array) => ({ result: Buffer.from(bytes).toString(), shouldReEncrypt: false }) },
      tabs: { request: async () => ({ ok: true }) }, confirm: async () => true,
    } as unknown as ShellPort
    const native = new OrchestratorApiClient({ send: message => owner.receive(message), shell, shellSnapshot: () => snapshot,
      event, publish: vi.fn(), report: message => { throw new Error(message) } })
    const owner = new ProcessCalls({ send: message => native.receive(message), invoke: invoked,
      event: (target, name, payload) => {
        if (target === 'shell' && name === 'snapshot') bridge.update(payload as ShellSnapshot)
        else if (target === 'shell' && name === 'notice') { const value = payload as { id: string; event: 'clicked' | 'closed' }; bridge.notice(value.id, value.event) }
        else if (target === 'orchestrator') notices(name, payload)
        else throw new Error('Unexpected test event')
      }, report: message => { throw new Error(message) } })
    const bridge = new ShellPortClient(owner, snapshot)
    return { native, owner, bridge, invoked, notices, event, snapshot, assign, unsubscribed, notice: (id: string) => notice(id, 'clicked'), groups: () => groups(snapshot.groups),
      close: () => { native.close(); owner.close(); bridge.dispose() } }
  }

  it('keeps callbacks usable before ready and requires both confirmed configuration and projections', async () => {
    const f = fixture()
    try {
      const read = f.native.api.viewerPath('window', 'document')
      expect(read).toBeInstanceOf(Promise)
      expect(f.invoked).not.toHaveBeenCalled()
      await expect(f.bridge.cipher.encrypt('secret')).resolves.toEqual(Buffer.from('secret'))
      f.owner.emit('orchestrator', 'event', { kind: 'projection', value: { processTree: { roots: [], sampledAt: 123 }, snapins: [{ kind: 'fixture', title: 'Fixture' }] } })
      expect(() => f.native.initialized()).toThrow('configuration is not ready')
      f.owner.emit('orchestrator', 'event', { kind: 'config', value: { ui: UiSettings.defaultValue() } })
      f.native.initialized()
      await expect(read).resolves.toEqual({ ok: true, path: 'verified' })
      expect(f.invoked).toHaveBeenCalledWith('orchestrator', 'viewerPath', ['window', 'document'], expect.any(Object))
      expect(f.native.api.snapinDefinitions()).toEqual([{ kind: 'fixture', title: 'Fixture' }])
      expect(f.event).toHaveBeenCalledExactlyOnceWith({ kind: 'config', value: { ui: UiSettings.defaultValue() } })
      const clicked = vi.fn(); f.bridge.onNotice(clicked); f.notice('id')
      expect(clicked).toHaveBeenCalledExactlyOnceWith('id', 'clicked')
      f.snapshot.groups = [{ key: 'session', group: 'working' } as never]
      f.groups()
      expect(f.bridge.sessionGroups.assignments()).toEqual(f.snapshot.groups)
    } finally { f.close() }
    expect(f.unsubscribed).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer native group push when an earlier write reply follows it', async () => {
    const f = fixture()
    try {
      const earlier = [{ key: 'session:one', group: 'waiting' }]
      const newer = [{ key: 'session:one', group: 'pinned' }]
      f.assign.mockImplementationOnce(async () => {
        f.snapshot.groups = earlier
        f.groups()
        return { ok: true, assignments: structuredClone(earlier) }
      })
      const write = f.bridge.sessionGroups.assign({ kind: 'assign', key: 'session:one', group: 'waiting' })
      f.snapshot.groups = newer
      f.groups()
      expect(await write).toEqual({ ok: true, assignments: earlier })
      expect(f.bridge.sessionGroups.assignments()).toEqual(newer)
    } finally { f.close() }
  })

  it('does not publish a refused group write as a confirmed snapshot', async () => {
    const f = fixture(), changed = vi.fn()
    try {
      f.bridge.sessionGroups.onChanged(changed)
      f.assign.mockResolvedValueOnce({ ok: false, assignments: [{ key: 'session:one', group: 'waiting' }] })
      expect((await f.bridge.sessionGroups.assign({ kind: 'assign', key: 'session:one', group: 'waiting' })).ok).toBe(false)
      expect(f.bridge.sessionGroups.assignments()).toEqual([])
      expect(changed).not.toHaveBeenCalled()
    } finally { f.close() }
  })

  it('rejects queued native requests after startup failure without dispatching them', async () => {
    const f = fixture()
    const pending = f.native.api.sessionsSnapshot()
    f.close()
    await expect(pending).rejects.toThrow('stopped before ready')
    expect(f.invoked).not.toHaveBeenCalled()
  })
  it('cancels a bounded media read over the native port through the public FileViewer API', async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), 'u26-port-media-'))
    const viewer = new FileViewer(), media = new FileViewerMediaView(viewer)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
    const read = viewer.readResourceBytes.bind(viewer)
    const publicRead = vi.spyOn(viewer, 'readResourceBytes').mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.detail)
      expect(result.value.bytes.length).toBe(65536)
      entered(); await held
      return result
    })
    try {
      const file = join(root, 'video.webm')
      await writeFile(file, Buffer.alloc(65536 * 3, 42))
      const opened = await viewer.openWorkspace('owner', 'session', root, file)
      if (!opened.ok) throw new Error(opened.detail)
      const grant = await viewer.exportResource('owner', opened.value.documentId)
      if (!grant.ok) throw new Error(grant.detail)
      f.invoked.mockImplementation(async (_target, method, args) => {
        if (method !== 'mediaOpen') throw new Error('Unexpected native method: ' + method)
        return media.open(args[0] as Parameters<FileViewerMediaView['open']>[0])
      })
      f.notices.mockImplementation((method, args) => { expect(method).toBe('mediaCancel'); media.cancel(args[0]) })
      f.owner.emit('orchestrator', 'event', { kind: 'projection', value: { processTree: {}, snapins: [] } })
      f.owner.emit('orchestrator', 'event', { kind: 'config', value: { ui: UiSettings.defaultValue() } })
      f.native.initialized()
      const controller = new AbortController(), source = new LocalFileMediaSource(f.native.api)
      const pending = source.read(grant.value.resourceId, grant.value.contentVersion, 0, 65536, controller.signal)
      const rejected = expect(pending).rejects.toThrow()
      await reading
      controller.abort(); await Promise.resolve(); await Promise.resolve()
      release(); await rejected
      expect(publicRead).toHaveBeenCalledTimes(1)
      expect(publicRead.mock.calls[0]![3]).toBe(65536)
      expect(publicRead.mock.calls[0]![4].aborted).toBe(true)
      expect(f.notices).toHaveBeenCalledTimes(1)
      expect(f.invoked).toHaveBeenCalledTimes(1)
    } finally { release(); publicRead.mockRestore(); media.stop(); f.close(); await rm(root, { recursive: true, force: true }) }
  })

})
