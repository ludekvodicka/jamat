import { CatalogView, type CatalogReading } from './catalogView'
import type { SessionUsageRecord } from '../sessionManager/sessionUsageView'
import { PathCompare } from '../shared/pathCompare'

export class TokenUsageProjectsView {
  private readonly catalog: CatalogReading
  private readonly records: readonly SessionUsageRecord[]
  private readonly paths: Map<string, string>

  constructor(configDir: string, records: readonly SessionUsageRecord[]) {
    this.catalog = CatalogView.load(configDir).read()
    this.records = records
    this.paths = new Map()
  }

  project(cwd: string, nativeId: string, agentId: 'claude' | 'codex'): string {
    const record = this.records.find(item => item.agentId === agentId && item.nativeSessionId === nativeId)
    const path = cwd || record?.cwd || ''
    const owner = record?.ownerPath ?? this.records.find(item => item.ownerPath !== null && PathCompare.isInside(item.cwd, path))?.ownerPath
    const binding = this.catalog.bind(path, owner ?? undefined)
    let displayPath: string
    if (binding.kind === 'project') displayPath = binding.projectPath
    else if (binding.kind === 'adHoc') displayPath = binding.path
    else if (binding.kind === 'none') return 'unknown'
    else throw new Error(`Unknown project binding: ${JSON.stringify(binding)}`)
    const key = PathCompare.comparable(displayPath)
    if (!this.paths.has(key)) this.paths.set(key, displayPath)
    return key
  }

  label(projectKey: string): string {
    if (projectKey === 'unknown') return 'Unknown project'
    const binding = this.catalog.bind(this.paths.get(projectKey) ?? projectKey)
    if (binding.kind === 'project') return binding.projectName
    else if (binding.kind === 'adHoc') return binding.path
    else if (binding.kind === 'none') return projectKey
    else throw new Error(`Unknown project binding: ${JSON.stringify(binding)}`)
  }
}
