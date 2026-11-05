import type { EventEmitter } from 'node:events'
import type { ProcessCallMessage, ProcessPowerMessage } from './processWire.types'
import type { TerminalFrame } from '../sessionManager/sessionManagerApi.types'

export type WindowTerminalPayload =
  | { type: 'terminal-frame'; attachId: string; frame: TerminalFrame }
  | { type: 'remote-terminal-frame'; endpointId: string; attachId: string; frame: TerminalFrame }

export type WindowMessage = ProcessCallMessage | ProcessPowerMessage
  | { type: 'alive' }
  | (WindowTerminalPayload & { generation: number; sequence: number })
  | { type: 'frame-received'; generation: number; sequence: number; failed?: true }
  | { type: 'stream-truncated'; generation: number }
  | { type: 'stream-reset'; generation: number }

export type UtilityWindowPort = Pick<EventEmitter, 'on'> & {
  postMessage(message: WindowMessage): void
  start(): void
  close(): void
}
