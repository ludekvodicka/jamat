import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabRequestPort } from '../../../lib-orchestrator/shared/tabRequestPort.types'
import { ClientStateStore } from '../clientState/clientStateStore'
import { RemarkableCredentialStore } from '../../../app-orchestrator/app/remarkable/storage/remarkableCredentialStore'
import { RemoteSessionGroups } from '../../../app-orchestrator/app/sessionGroups/remoteSessionGroups'
import { SessionsGroupsState } from '../../shared/sessionsGroupsState'
import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ElectronShellPort } from './electronShellPort'

const native = vi.hoisted(() => ({
  save: vi.fn(), openPath: vi.fn(), openExternal: vi.fn(), available: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  notices: [] as EventEmitter[], supported: true,
}))
vi.mock('electron', () => ({
  dialog: { showSaveDialog: native.save }, shell: { openPath: native.openPath, openExternal: native.openExternal },
  safeStorage: { isAsyncEncryptionAvailable: native.available, encryptStringAsync: native.encrypt, decryptStringAsync: native.decrypt },
  Notification: class extends EventEmitter {
    static isSupported(): boolean { return native.supported }
    readonly options: unknown
    constructor(options: unknown) { super(); this.options = options; native.notices.push(this) }
    show(): void {}
    close(): void { this.emit('close') }
  },
}))

describe('ElectronShellPort', () => {
  const roots: string[] = []
  beforeEach(() => { vi.resetAllMocks(); native.notices.length = 0; native.supported = true })
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function fixture() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-shell-port-')))
    roots.push(root)
    const stateFile = join(root, 'state.json')
    const store = new ClientStateStore(stateFile, join(root, 'snapshots'), () => {})
    const dialogs = { confirmPairing: vi.fn(async () => false), confirmInboundAccess: vi.fn(async () => false),
      confirmMainWindowClose: vi.fn(async () => false) }
    const restart = vi.fn(async () => true), quit = vi.fn()
    const shell = new ElectronShellPort({ groups: store, parent: () => null, dialogs, tabs: {} as TabRequestPort, restart, quit })
    return { root, stateFile, store, dialogs, shell, restart, quit }
  }

  it('routes each confirmation and preserves cancellation from the shell', async () => {
    const { shell, dialogs } = fixture()
    const peer = { remoteComputerId: 'machine', remoteEndpointId: 'endpoint', displayName: 'Peer', fingerprint: 'fingerprint' }
    expect(await shell.confirm({ kind: 'pairing', request: { ...peer, source: 'bundle' } })).toBe(false)
    expect(dialogs.confirmPairing).toHaveBeenCalledExactlyOnceWith(null, { ...peer, source: 'bundle' })
    expect(await shell.confirm({ kind: 'inbound', request: { ...peer, remoteAddress: '127.0.0.1' } })).toBe(false)
    expect(dialogs.confirmInboundAccess).toHaveBeenCalledExactlyOnceWith(null, { ...peer, remoteAddress: '127.0.0.1' })
    expect(await shell.confirm({ kind: 'close-main', holderCount: 3 })).toBe(false)
    expect(dialogs.confirmMainWindowClose).toHaveBeenCalledExactlyOnceWith(null, 3)
  })

  it('preserves credential schema and rewrites shouldReEncrypt ciphertext through the binary port', async () => {
    const { root, shell } = fixture()
    const file = join(root, 'credential.json')
    native.available.mockResolvedValue(true)
    native.encrypt.mockImplementation(async (value: string) => Buffer.from(`cipher:${value}`))
    native.decrypt.mockImplementation(async (value: Buffer) => ({ result: value.toString().slice(7), shouldReEncrypt: true }))
    const credentials = new RemarkableCredentialStore(file, 'test-identity', 'development', shell.cipher)
    expect(await credentials.replace('10.11.99.1', 'test-password')).toMatchObject({ ok: true })
    expect(await credentials.passwordFor('10.11.99.1')).toEqual({ ok: true, value: 'test-password' })
    expect(native.encrypt).toHaveBeenCalledTimes(2)
    expect(native.decrypt.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array)
    const record = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(record).sort()).toEqual(['channel', 'configIdentity', 'encryptedBase64', 'host', 'schemaVersion', 'updatedAt'])
    expect(record).toMatchObject({ schemaVersion: 1, configIdentity: 'test-identity', channel: 'development', host: '10.11.99.1' })
    native.available.mockResolvedValue(false)
    expect(await credentials.passwordFor('10.11.99.1')).toMatchObject({ ok: false, code: 'credential-unavailable' })
    expect(native.encrypt).toHaveBeenCalledTimes(2)
  })

  it('pushes every native assignment writer into the orchestration cache', async () => {
    const { shell, store } = fixture()
    const changed = vi.fn()
    const groups = new RemoteSessionGroups(() => SessionsGroupsState.defaultsConst, shell.sessionGroups, changed)
    const session = { sessionId: 'child', project: { kind: 'none' } } as SessionInfo
    expect(store.assignSessionGroup('session:child', 'priority')).toBe(true)
    expect(groups.read([session]).get('child')).toBe('priority')
    expect(store.saveSessionPins(['session:child'])).toBe(true)
    expect(groups.read([session]).get('child')).toBe('pinned')
    expect(store.assignSessionGroup('session:parent', 'waiting')).toBe(true)
    await groups.inherit('parent', 'child')
    expect(groups.read([session]).get('child')).toBe('waiting')
    expect(await groups.assign('child', 'completed')).toEqual({ ok: true, value: { group: 'completed' } })
    expect(groups.read([session]).get('child')).toBe('completed')
    expect(await shell.sessionGroups.assign({ kind: 'prune', groupIds: ['none', 'completed'] }))
      .toEqual({ ok: true, assignments: [{ key: 'session:child', group: 'completed' }] })
    expect(await shell.sessionGroups.assign({ kind: 'replace', assignments: [] })).toEqual({ ok: true, assignments: [] })
    expect(groups.read([session]).get('child')).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
    groups.dispose()
  })

  it('does not publish a refused native write', async () => {
    const { shell, stateFile } = fixture()
    writeFileSync(stateFile, '{broken')
    const changed = vi.fn()
    const unsubscribe = shell.sessionGroups.onChanged(changed)
    expect(await shell.sessionGroups.assign({ kind: 'assign', key: 'session:child', group: 'completed' }))
      .toEqual({ ok: false, assignments: [] })
    expect(await shell.sessionGroups.assign({ kind: 'prune', groupIds: ['none', 'completed'] }))
      .toEqual({ ok: false, assignments: [] })
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('routes save, path refusal, notices, restart and quit without native values in results', async () => {
    const { shell, restart, quit } = fixture()
    native.save.mockResolvedValueOnce({ canceled: true }).mockResolvedValueOnce({ canceled: false, filePath: 'Q:/saved.txt' })
    expect(await shell.saveDialog({ title: 'Save' })).toBeNull()
    expect(await shell.saveDialog({ title: 'Save', defaultPath: 'source.txt' })).toBe('Q:/saved.txt')
    native.openPath.mockResolvedValueOnce('cannot open').mockResolvedValueOnce('')
    await expect(shell.openPath('missing')).rejects.toThrow('cannot open')
    await expect(shell.openPath('present')).resolves.toBeUndefined()
    await shell.openExternal('https://example.test/')
    expect(native.openExternal).toHaveBeenCalledWith('https://example.test/')
    const events = vi.fn()
    shell.onNotice(events)
    shell.notify({ id: 'one', title: 'Title', body: 'Body' })
    native.notices[0]!.emit('click')
    native.notices[0]!.emit('close')
    expect(events).toHaveBeenCalledExactlyOnceWith('one', 'clicked')
    native.supported = false
    shell.notify({ id: 'unsupported', title: 'Title', body: 'Body' })
    expect(events).toHaveBeenLastCalledWith('unsupported', 'closed')
    native.supported = true
    shell.notify({ id: 'two', title: 'Title', body: 'Body' })
    shell.dispose()
    expect(events).toHaveBeenLastCalledWith('two', 'closed')
    expect(await shell.restart('test')).toBe(true)
    expect(restart).toHaveBeenCalledWith('test')
    shell.quit()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
