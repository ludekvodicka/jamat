export interface AgentCliUpdateRow {
  id: string
  label: string
  activity: 'idle' | 'checking' | 'updating'
  installedVersion: string | null
  latestVersion: string | null
  path: string | null
  channel: string | null
  available: boolean
  canUpdate: boolean
  detail: string | null
  error: string | null
  output: string
  checkedAt: number | null
}

export interface AgentCliUpdatesSnapshot {
  revision: number
  agents: readonly AgentCliUpdateRow[]
}
