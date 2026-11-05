import type { TerminalAttachSpec } from './sessionManagerApi.types'

export interface WindowTerminalMethods {
  'terminal:attach': [attachId: string, spec: TerminalAttachSpec]
  'terminal:input': [attachId: string, data: string]
  'terminal:resize': [attachId: string, cols: number, rows: number]
  'terminal:active': [attachId: string, active: boolean]
  'terminal:detach': [attachId: string]
}
export type WindowTerminalCall = {
  [K in keyof WindowTerminalMethods]: { method: K; args: WindowTerminalMethods[K] }
}[keyof WindowTerminalMethods]
