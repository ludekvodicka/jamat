import type { TerminalTarget } from '../shared/tabRequestPort.types'

export type ScriptRunHandOff = { target: TerminalTarget; title: string } | null
export type ScriptRunCollapsed = (runKey: string, handOff: ScriptRunHandOff) => void
