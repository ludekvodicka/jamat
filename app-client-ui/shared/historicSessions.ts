import type { CategoryInfo, ProjectEntry, ProviderSessionSummary } from '../../lib-orchestrator/projectManager/projectManagerApi.types'

export interface HistoricSession extends Omit<ProviderSessionSummary, 'lastActivity'> {
  lastActivity: number | null
  /**
   * When the session ended, as AppJamat recorded it. Null while it runs, and null for a session
   * nobody here ever ran: a foreign transcript carries no ending, only the time it last changed.
   */
  endedAt: number | null
  model: string | null
}

export interface HistoricSessionGroup {
  root: Pick<CategoryInfo, 'id' | 'label' | 'path'>
  project: Pick<ProjectEntry, 'name' | 'path'>
  sessions: HistoricSession[]
}
