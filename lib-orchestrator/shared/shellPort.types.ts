import type { SessionGroup } from '../sessionManager/sessionManagerApi.types'
import type { TabRequestPort } from './tabRequestPort.types'

export interface ShellPairingConfirmRequest {
  remoteComputerId: string
  remoteEndpointId: string
  displayName: string
  fingerprint: string
  source: 'bundle' | 'address'
}

export interface ShellInboundConfirmRequest {
  remoteComputerId: string
  remoteEndpointId: string
  displayName: string
  fingerprint: string
  remoteAddress: string
}

export type ShellConfirmRequest =
  | { kind: 'pairing'; request: ShellPairingConfirmRequest }
  | { kind: 'inbound'; request: ShellInboundConfirmRequest }
  | { kind: 'close-main'; holderCount: number }

export interface ShellSecretCipher {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Uint8Array>
  decrypt(value: Uint8Array): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export interface ShellGroupAssignment { key: string; group: SessionGroup }
export type ShellGroupChange =
  | { kind: 'assign'; key: string; group: SessionGroup }
  | { kind: 'inherit'; parentKey: string; key: string }
  | { kind: 'replace'; assignments: readonly ShellGroupAssignment[] }
  | { kind: 'prune'; groupIds: readonly SessionGroup[] }
export interface ShellGroupWrite { ok: boolean; assignments: readonly ShellGroupAssignment[] }
export interface ShellSessionGroups {
  assignments(): readonly ShellGroupAssignment[]
  assign(change: ShellGroupChange): Promise<ShellGroupWrite>
  onChanged(listener: (assignments: readonly ShellGroupAssignment[]) => void): () => void
}

export type ShellClipboardRead =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'empty' }
  | { kind: 'too-large' }

export interface ShellNotice { id: string; title: string; body: string }
export interface ShellPort {
  confirm(request: ShellConfirmRequest): Promise<boolean>
  saveDialog(request: { title: string; defaultPath?: string }): Promise<string | null>
  notify(notice: ShellNotice): void
  onNotice(listener: (id: string, event: 'clicked' | 'closed') => void): () => void
  cipher: ShellSecretCipher
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  clipboardForPaste(): Promise<ShellClipboardRead>
  tabs: TabRequestPort
  sessionGroups: ShellSessionGroups
  restart(reason: string): Promise<boolean>
  quit(): void
}
