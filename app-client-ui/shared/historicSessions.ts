import type { CategoryInfo, ProjectEntry, ProviderSessionSummary } from '../../lib-orchestrator/projectManager/projectManagerApi.types'

export interface HistoricSession extends Omit<ProviderSessionSummary, 'lastActivity'> {
  lastActivity: number | null
  model: string | null
}

export interface HistoricSessionGroup {
  root: Pick<CategoryInfo, 'id' | 'label' | 'path'>
  project: Pick<ProjectEntry, 'name' | 'path'>
  sessions: HistoricSession[]
}
