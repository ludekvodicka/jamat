import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type {
  FileChangesSnapshot,
  FileChangesWorkingTreeSnapshot,
  FileDiffRequest,
  FileDiffResult,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileDiffExecutionContext } from '../../../lib-orchestrator/fileChangesManager/diff/fileDiffExecutor'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceFileChangesIpc } from './serviceFileChangesIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/fileChanges/serviceFileChangesIpc', () => {
  const sender = {} as WebContents
  const other = {} as WebContents
  const snapshot: FileChangesSnapshot = {
    snapshotId: 'snapshot-1',
    sessionId: 'session-1',
    createdAt: 1,
    vcs: {
      requested: 'git', selected: 'git', available: ['git'], root: 'C:/work', fallbackReason: null,
    },
    defaultBaseline: {
      baselineId: 'baseline-1', kind: 'git-head', label: 'HEAD', revision: 'HEAD', createdAt: null,
    },
    entries: [{
      fileId: 'file-1', path: 'C:/work/a.ts', displayPath: 'a.ts', nodeKind: 'file',
      location: 'workspace', status: 'modified', previousPath: null, previousDisplayPath: null,
      modifiedAt: 1,
      sources: ['vcs'], gitState: null,
    }],
    history: { groups: [], nextCursor: null },
    warnings: [],
  }
  const document: FileViewerDocument = {
    documentId: 'document-1',
    documentKey: 'key-1',
    source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/a.ts' },
    path: 'C:/work/a.ts',
    name: 'a.ts',
    size: 10,
    contentVersion: '10:1',
    kind: { kind: 'code', language: 'typescript' },
    modes: ['rendered', 'raw', 'diff'],
  }
  const workingSnapshot: FileChangesWorkingTreeSnapshot = {
    externalRoots: [],
    snapshotId: 'working-snapshot-1',
    sessionId: 'session-1',
    createdAt: 1,
    source: {
      requested: 'checkpoint',
      selected: 'checkpoint',
      available: ['checkpoint', 'svn'],
      fallbackReason: null,
    },
    defaultBaseline: snapshot.defaultBaseline,
    entries: snapshot.entries,
    warnings: [],
  }
  let calls: { method: string; args: unknown[] }[]
  let service: ServiceFileChangesIpc
  let runDiff: (
    request: FileDiffRequest,
    context?: FileDiffExecutionContext,
  ) => Promise<FileDiffResult>

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    calls = []
    runDiff = () => Promise.resolve({ ok: true, kind: 'source-unavailable', detail: 'none' })
    const manager = {
      workingSnapshot: () => workingSnapshot,
      list: (...args: unknown[]) => {
        calls.push({ method: 'list', args })
        return Promise.resolve({ ok: true as const, value: snapshot })
      },
      workingTree: (...args: unknown[]) => {
        calls.push({ method: 'workingTree', args })
        return Promise.resolve({ ok: true as const, value: workingSnapshot })
      },
      history: (...args: unknown[]) => {
        calls.push({ method: 'history', args })
        return { ok: true as const, value: { groups: [], nextCursor: null } }
      },
      diff: (...args: unknown[]) => {
        calls.push({ method: 'diff', args })
        return runDiff(
          args[0] as FileDiffRequest,
          args[1] as FileDiffExecutionContext | undefined,
        )
      },
      fileAccess: (...args: unknown[]) => {
        calls.push({ method: 'fileAccess', args })
        return {
          ok: true as const,
          value: {
            sessionId: 'session-1', cwd: 'C:/work', path: 'C:/work/a.ts',
            nodeKind: 'file' as const, status: 'modified' as const,
          },
        }
      },
    } as unknown as FileChangesManager
    const viewer = {
      openChanged: (...args: unknown[]) => {
        calls.push({ method: 'openChanged', args })
        return Promise.resolve({ ok: true as const, value: document })
      },
      restoreExternal: (...args: unknown[]) => {
        calls.push({ method: 'restoreExternal', args })
        return Promise.resolve({ ok: true as const, value: document })
      },
    } as unknown as FileViewer
    const sessions = {
      workingContext: (sessionId: string) => Promise.resolve({
        ok: true as const,
        value: { sessionId, cwd: 'C:/work', agent: null, worktree: null },
      }),
    } as unknown as SessionManager
    const config = { readSection: () => ({ primaryVcs: 'git' }) } as unknown as ConfigStore
    service = new ServiceFileChangesIpc(
      manager,
      viewer,
      sessions,
      config,
      (value) => value === sender ? 'window-1' : value === other ? 'window-2' : null,
    )
    service.initialize()
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    source: WebContents,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender: source } as IpcMainInvokeEvent, ...args)
  }

  it('derives the context and configured VCS in the main process', async () => {
    expect(await invoke('fileChanges:list', sender, 'session-1', null))
      .toEqual({ ok: true, value: { ok: true, value: snapshot } })
    expect(calls[0]).toEqual({
      method: 'list',
      args: [
        { sessionId: 'session-1', cwd: 'C:/work', agent: null, worktree: null },
        { preferredVcs: 'git' },
      ],
    })
  })

  it('shares the existing owner check with commit target and snapshot reads', async () => {
    await invoke('fileChanges:working-tree', sender, 'session-1', 'svn')
    expect(service.ownedWorkingTreeSnapshot('window-1', workingSnapshot.snapshotId)).toEqual(workingSnapshot)
    expect(service.ownedWorkingTreeSnapshot('window-2', workingSnapshot.snapshotId)).toBeNull()
    expect(service.ownedFileAccess('window-1', workingSnapshot.snapshotId, 'file-1').ok).toBe(true)
    expect(service.ownedFileAccess('window-2', workingSnapshot.snapshotId, 'file-1').ok).toBe(false)
    service.revokeOwner('window-1')
    expect(service.ownedWorkingTreeSnapshot('window-1', workingSnapshot.snapshotId)).toBeNull()
  })

  it('derives worktree context and single-flights each requested current source', async () => {
    const answers = await Promise.all([
      invoke('fileChanges:working-tree', sender, 'session-1', 'checkpoint'),
      invoke('fileChanges:working-tree', other, 'session-1', 'checkpoint'),
    ])

    expect(calls.filter((call) => call.method === 'workingTree')).toHaveLength(1)
    expect(calls.find((call) => call.method === 'workingTree')?.args).toEqual([
      { sessionId: 'session-1', cwd: 'C:/work', agent: null, worktree: null },
      'checkpoint',
      false,
    ])
    for (const answer of answers)
      expect(answer).toEqual({ ok: true, value: { ok: true, value: workingSnapshot } })

    expect(await invoke('fileChanges:history', sender, workingSnapshot.snapshotId, 'cursor'))
      .toEqual({ ok: true, value: { ok: true, value: { groups: [], nextCursor: null } } })
    expect(await invoke('fileChanges:history', other, workingSnapshot.snapshotId, 'cursor'))
      .toEqual({ ok: true, value: { ok: true, value: { groups: [], nextCursor: null } } })
    service.revokeOwner('window-1')
    expect(await invoke('fileChanges:history', other, workingSnapshot.snapshotId, 'cursor'))
      .toEqual({ ok: true, value: { ok: true, value: { groups: [], nextCursor: null } } })

    await Promise.all([
      invoke('fileChanges:working-tree', sender, 'session-1', 'checkpoint'),
      invoke('fileChanges:working-tree', sender, 'session-1', 'svn'),
    ])
    expect(calls.filter((call) => call.method === 'workingTree')).toHaveLength(3)
  })

  it('keeps commit reads separate from simultaneous sidebar reads of the same scope', async () => {
    await Promise.all([
      service.workingTree('window-1', 'session-1', 'svn', 'C:/work'),
      service.workingTree('window-1', 'session-1', 'svn', 'C:/work', true),
    ])
    const reads = calls.filter((call) => call.method === 'workingTree')
    expect(reads).toHaveLength(2)
    expect(reads.map((read) => read.args[2]).sort()).toEqual([false, true])
  })

  /**
   * A listing detects both VCS, runs a status, reads a hundred commits and parses the session's whole
   * transcript. Four panels mounting at once on a restored layout used to start four of them, and
   * the renderer's own guard discards the answer rather than the work.
   */
  it('runs one listing per session, however many callers ask at once', async () => {
    const answers = await Promise.all([
      invoke('fileChanges:list', sender, 'session-1', null),
      invoke('fileChanges:list', other, 'session-1', null),
      invoke('fileChanges:list', sender, 'session-1', null),
    ])

    expect(calls.filter((call) => call.method === 'list')).toHaveLength(1)
    for (const answer of answers)
      expect(answer).toEqual({ ok: true, value: { ok: true, value: snapshot } })
  })

  // A different VCS is a different question, so it is not joined to the one in flight.
  it('does not join a listing that asked for another VCS', async () => {
    await Promise.all([
      invoke('fileChanges:list', sender, 'session-1', 'git'),
      invoke('fileChanges:list', sender, 'session-1', 'svn'),
    ])

    expect(calls.filter((call) => call.method === 'list')).toHaveLength(2)
  })

  it('binds history, diffs and changed-file opens to the snapshot owner', async () => {
    await invoke('fileChanges:list', sender, 'session-1', 'svn')
    // The picker is the reason this argument exists: without this assertion the whole
    // `preferredVcs ?? config` expression could be replaced by the config alone and stay green,
    // which turns the VCS selector in the panel into an ornament.
    expect(calls.at(-1)?.args[1]).toEqual({ preferredVcs: 'svn' })
    expect(await invoke('fileChanges:history', other, 'snapshot-1', 'cursor')).toEqual({
      ok: true,
      value: { ok: false, code: 'snapshot-expired', detail: 'The file changes snapshot expired' },
    })
    const request: FileDiffRequest = {
      snapshotId: 'snapshot-1', fileId: 'file-1', baselineId: 'baseline-1',
    }
    expect(await invoke('fileChanges:diff', sender, request)).toEqual({
      ok: true,
      value: { ok: true, kind: 'source-unavailable', detail: 'none' },
    })
    expect(await invoke('fileChanges:open-file', sender, 'snapshot-1', 'file-1'))
      .toEqual({ ok: true, value: { ok: true, value: document } })
    expect(calls.map((call) => call.method)).toContain('openChanged')
  })

  it('revokes every snapshot owned by a renderer generation', async () => {
    await invoke('fileChanges:list', sender, 'session-1', null)
    service.revokeOwner('window-1')
    expect(await invoke('fileChanges:history', sender, 'snapshot-1', 'cursor')).toEqual({
      ok: true,
      value: { ok: false, code: 'snapshot-expired', detail: 'The file changes snapshot expired' },
    })
  })

  it('deduplicates diffs, enforces per-owner admission and recovers after completion', async () => {
    await invoke('fileChanges:list', sender, 'session-1', null)
    const pending: ((result: FileDiffResult) => void)[] = []
    runDiff = () => new Promise((resolve) => { pending.push(resolve) })
    const request = (suffix: string): FileDiffRequest => ({
      snapshotId: snapshot.snapshotId,
      fileId: `file-${suffix}`,
      baselineId: `baseline-${suffix}`,
    })

    const first = invoke('fileChanges:diff', sender, request('a'))
    const duplicate = invoke('fileChanges:diff', sender, request('a'))
    const second = invoke('fileChanges:diff', sender, request('b'))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(calls.filter((call) => call.method === 'diff')).toHaveLength(2)
    expect(await invoke('fileChanges:diff', sender, request('c'))).toEqual({
      ok: true,
      value: {
        ok: true,
        kind: 'busy',
        detail: 'This window has too many file diffs in flight',
      },
    })

    for (const finish of pending.splice(0))
      finish({ ok: true, kind: 'source-unavailable', detail: 'done' })
    await Promise.all([first, duplicate, second])
    const recovered = invoke('fileChanges:diff', sender, request('c'))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!({ ok: true, kind: 'source-unavailable', detail: 'recovered' })
    await expect(recovered).resolves.toEqual({
      ok: true,
      value: { ok: true, kind: 'source-unavailable', detail: 'recovered' },
    })
  })

  it('cancels a shared diff only after its last owner is revoked', async () => {
    await Promise.all([
      invoke('fileChanges:list', sender, 'session-1', null),
      invoke('fileChanges:list', other, 'session-1', null),
    ])
    let signal: AbortSignal | undefined
    runDiff = (_request, context) => new Promise((resolve) => {
      signal = context?.signal
      signal?.addEventListener('abort', () => {
        resolve({ ok: true, kind: 'busy', detail: 'cancelled' })
      }, { once: true })
    })
    const request: FileDiffRequest = {
      snapshotId: snapshot.snapshotId,
      fileId: 'file-1',
      baselineId: 'baseline-1',
    }
    const first = invoke('fileChanges:diff', sender, request)
    const second = invoke('fileChanges:diff', other, request)
    await vi.waitFor(() => expect(signal).toBeDefined())

    service.revokeOwner('window-1')
    expect(signal?.aborted).toBe(false)
    service.revokeOwner('window-2')
    expect(signal?.aborted).toBe(true)
    await Promise.all([first, second])
  })
})
