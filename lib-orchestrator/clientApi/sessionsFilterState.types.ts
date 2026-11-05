import type { SessionAgentId, SessionColorName } from '../sessionManager/sessionManagerApi.types'

export type SessionFilterStatus = 'active' | 'attention' | 'running' | 'question' | 'idle' | 'starting' | 'background' | 'ended' | 'lost' | 'completed' | 'unknown' | 'closedRecently'

export interface SessionsFilterValue {
  colors: readonly (SessionColorName | null)[]
  states: readonly SessionFilterStatus[]
  agents: readonly (SessionAgentId | null)[]
}

export interface SavedSessionsFilter {
  id: string
  name: string
  filters: SessionsFilterValue
  filterText: string
}
