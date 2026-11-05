import type { TerminalAttachSpec, TerminalFrame } from './sessionManagerApi.types'
import type { TerminalAttachOwner, TerminalRefChange } from './terminalPort'

export interface TerminalProcessMethods {
  attach: [attachId: string, spec: TerminalAttachSpec, owner: Pick<TerminalAttachOwner, 'source' | 'windowId'>]
  input: [attachId: string, data: string]
  resize: [attachId: string, cols: number, rows: number]
  active: [attachId: string, active: boolean]
  authorize: [windowId: string, attachId: string]
  inhibit: [sessionId: string]
  transaction: [attachId: string]
  write: [token: string, data: string]
  pendingInput: [sessionId: string]
  publishRefs: [changes: readonly TerminalRefChange[]]
  close: []
}
export type TerminalProcessCall = {
  [K in keyof TerminalProcessMethods]: { method: K; args: TerminalProcessMethods[K] }
}[keyof TerminalProcessMethods]

export type TerminalProcessEvent =
  | { name: 'frame'; payload: { attachId: string; frame: TerminalFrame } }
  | { name: 'userInput'; payload: readonly { sessionId: string; at: number }[] }
  | { name: 'pendingInputHint'; payload: readonly [string, number][] }

export type TerminalProcessControl =
  | { name: 'detach'; payload: string }
  | { name: 'release'; payload: string }
  | { name: 'end'; payload: string }
