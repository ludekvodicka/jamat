import { dialog, Notification, safeStorage, shell, type BrowserWindow } from 'electron'
import type { ShellClipboardRead, ShellConfirmRequest, ShellGroupChange, ShellGroupWrite, ShellNotice, ShellPort, ShellSecretCipher, ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'
import type { TabRequestPort } from '../../../lib-orchestrator/shared/tabRequestPort.types'
import { PastedFileStore } from '../../../lib-orchestrator/pastedFiles/pastedFileStore'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { ClipboardAccess } from '../shared/clipboardAccess'
import type { ServiceDialogIpc } from './serviceDialogIpc'

export interface ElectronShellPortDeps {
  dialogs: Pick<ServiceDialogIpc, 'confirmPairing' | 'confirmInboundAccess' | 'confirmMainWindowClose'>
  parent(): BrowserWindow | null
  tabs: TabRequestPort
  groups: Pick<ClientStateStore, 'loadSessionGroups' | 'assignSessionGroup' | 'inheritSessionGroup' | 'saveSessionGroups' | 'pruneSessionGroups' | 'onSessionGroupsChanged'>
  restart(reason: string): Promise<boolean>
  quit(): void
}

export class ElectronShellPort implements ShellPort {
  readonly tabs: TabRequestPort
  readonly cipher: ShellSecretCipher
  readonly sessionGroups: ShellSessionGroups
  private readonly deps: ElectronShellPortDeps
  private readonly notices: Map<string, Notification>
  private readonly noticeListeners: Set<(id: string, event: 'clicked' | 'closed') => void>

  constructor(deps: ElectronShellPortDeps) {
    this.deps = deps
    this.tabs = deps.tabs
    this.notices = new Map()
    this.noticeListeners = new Set()
    this.cipher = {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: value => safeStorage.decryptStringAsync(Buffer.from(value)),
    }
    this.sessionGroups = {
      assignments: () => structuredClone(this.deps.groups.loadSessionGroups()),
      assign: change => this.assignGroup(change),
      onChanged: listener => this.deps.groups.onSessionGroupsChanged(listener),
    }
  }

  confirm(request: ShellConfirmRequest): Promise<boolean> {
    if (request.kind === 'pairing') return this.deps.dialogs.confirmPairing(this.deps.parent(), request.request)
    else if (request.kind === 'inbound') return this.deps.dialogs.confirmInboundAccess(this.deps.parent(), request.request)
    else if (request.kind === 'close-main') return this.deps.dialogs.confirmMainWindowClose(this.deps.parent(), request.holderCount)
    else throw new Error(`Unknown shell confirmation: ${JSON.stringify(request satisfies never)}`)
  }

  async saveDialog(request: { title: string; defaultPath?: string }): Promise<string | null> {
    const result = await dialog.showSaveDialog(request)
    return result.canceled ? null : result.filePath ?? null
  }

  notify(notice: ShellNotice): void {
    if (!Notification.isSupported()) {
      for (const listener of this.noticeListeners) listener(notice.id, 'closed')
      return
    }
    const toast = new Notification({ title: notice.title, body: notice.body })
    this.notices.set(notice.id, toast)
    toast.on('click', () => this.noticeEvent(notice.id, toast, 'clicked'))
    toast.on('close', () => this.noticeEvent(notice.id, toast, 'closed'))
    toast.show()
  }

  onNotice(listener: (id: string, event: 'clicked' | 'closed') => void): () => void {
    this.noticeListeners.add(listener)
    return () => { this.noticeListeners.delete(listener) }
  }

  private noticeEvent(id: string, toast: Notification, event: 'clicked' | 'closed'): void {
    if (this.notices.get(id) !== toast) return
    this.notices.delete(id)
    for (const listener of this.noticeListeners) listener(id, event)
  }

  async openPath(path: string): Promise<void> {
    const refusal = await shell.openPath(path)
    if (refusal) throw new Error(refusal)
  }

  openExternal(url: string): Promise<void> { return shell.openExternal(url) }

  async clipboardForPaste(): Promise<ShellClipboardRead> {
    const text = ClipboardAccess.readText()
    if (text.length > 0) return { kind: 'text', text }
    const path = ClipboardAccess.readFileDrop()
    if (path !== null) return { kind: 'file', path }
    const image = ClipboardAccess.readImage(PastedFileStore.imageBytesMaxConst)
    if (image.kind === 'none') return { kind: 'empty' }
    else if (image.kind === 'image') return image
    else if (image.kind === 'too-large') return image
    else throw new Error(`Unknown clipboard read: ${JSON.stringify(image satisfies never)}`)
  }

  restart(reason: string): Promise<boolean> { return this.deps.restart(reason) }
  quit(): void { this.deps.quit() }

  private async assignGroup(change: ShellGroupChange): Promise<ShellGroupWrite> {
    let ok: boolean
    if (change.kind === 'assign') ok = this.deps.groups.assignSessionGroup(change.key, change.group)
    else if (change.kind === 'inherit') ok = this.deps.groups.inheritSessionGroup(change.parentKey, change.key)
    else if (change.kind === 'replace') ok = this.deps.groups.saveSessionGroups(change.assignments)
    else if (change.kind === 'prune') ok = this.deps.groups.pruneSessionGroups(change.groupIds)
    else throw new Error(`Unknown session group change: ${JSON.stringify(change satisfies never)}`)
    const assignments = this.sessionGroups.assignments()
    return { ok, assignments }
  }

  dispose(): void {
    for (const toast of this.notices.values()) toast.close()
    this.notices.clear()
    this.noticeListeners.clear()
  }
}
