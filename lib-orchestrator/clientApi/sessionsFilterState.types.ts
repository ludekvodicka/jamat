import type { AutomationState, SessionAgentId, SessionColorName } from '../sessionManager/sessionManagerApi.types'

export type SessionFilterStatus = 'active' | 'attention' | 'running' | 'question' | 'idle' | 'starting' | 'background' | 'ended' | 'lost' | 'completed' | 'unknown' | 'closedRecently'

/** A bot state, or `none` for a row without a chip. */
export type SessionFilterAutomation = AutomationState | 'none'

export interface SessionsFilterValue {
  colors: readonly (SessionColorName | null)[]
  states: readonly SessionFilterStatus[]
  agents: readonly (SessionAgentId | null)[]
  /** Optional so a preset saved before the bot state chips stays valid; absent reads as `[]`. */
  automation?: readonly SessionFilterAutomation[]
}

export interface SavedSessionsFilter {
  id: string
  name: string
  filters: SessionsFilterValue
  filterText: string
}
