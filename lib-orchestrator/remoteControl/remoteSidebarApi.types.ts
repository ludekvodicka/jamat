export interface RemoteDirectoryNote {
  text: string
  large?: boolean
  sticky?: boolean
}

export type RemoteSidebarRequest =
  | { kind: 'notes' }
  | { kind: 'model' }
  | { kind: 'transcript' }
  | { kind: 'save-notes'; notes: readonly RemoteDirectoryNote[]; operationId: string }
  | { kind: 'import-prompt'; operationId: string }
  | { kind: 'compact'; action: 'claim' | 'note' | 'cooldown' | 'deliver'; operationId: string }
