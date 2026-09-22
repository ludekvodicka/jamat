import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import type { VersioningCommitManager } from './versioningCommitManager'
import { ServiceVersioningCommitIpc } from './serviceVersioningCommitIpc'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) } }))

describe('app-client-ui/app/versioning/serviceVersioningCommitIpc', () => {
  it('filters the owned commit list to the requested paths', async () => {
    handlers.clear()
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const snapshot = { snapshotId: 'snapshot' }
    const filtered = { ...snapshot, entries: [] }
    const manager = { read: vi.fn(() => ({ sessionId: 'session', source: 'svn', scopeRoot: 'scope' })),
      files: vi.fn(() => filtered) } as unknown as VersioningCommitManager
    const files = { workingTree: vi.fn(async () => ({ ok: true as const, value: snapshot as never })) }
    new ServiceVersioningCommitIpc(manager, () => 'window', files, vi.fn(), { launch: vi.fn() }, vi.fn()).initialize()
    expect(await handlers.get('versioning:commit-files')!({ sender }, 'draft')).toEqual({ ok: true, value: { ok: true, value: filtered } })
    expect(manager.read).toHaveBeenCalledWith('window', 'draft')
    expect(files.workingTree).toHaveBeenCalledWith('window', 'session', 'svn', 'scope', true)
    expect(manager.files).toHaveBeenCalledWith('window', 'draft', snapshot)
  })

  it('registers every channel and preserves owners over reload while releasing a dead window', async () => {
    handlers.clear()
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const revoked: string[] = []
    const attached: string[] = []
    const manager = {
      prepare: async () => ({ ok: true, value: { draftId: 'draft', scopeRoot: 'scope', title: 'Commit' }, messageApplied: false }),
      attach: (id: string, owner: string) => attached.push(`${id}:${owner}`),
      revokeOwner: (owner: string) => revoked.push(owner),
    } as unknown as VersioningCommitManager
    new ServiceVersioningCommitIpc(manager, (value) => value === sender as unknown as WebContents ? 'window' : null, { workingTree: vi.fn() }, vi.fn(), { launch: vi.fn() }, vi.fn()).initialize()
    expect([...handlers.keys()].sort()).toEqual(Object.keys(ServiceVersioningCommitIpc.channelsConst).sort())
    await handlers.get('versioning:commit-open-draft')!({ sender }, 'session', 'svn', null)
    expect(attached).toEqual(['draft:window'])
    sender.emit('did-start-navigation', {}, '', false, true)
    expect(revoked).toEqual([])
    sender.emit('destroyed')
    expect(revoked).toEqual(['window'])
  })
})
