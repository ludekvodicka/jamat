import type { ProjectManager } from '../../../../lib-orchestrator/projectManager/projectManager'
import type { ProjectsOpResult } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { SessionManager } from '../../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionModelReader } from '../../../../lib-orchestrator/sessionModelReader/sessionModelReader'
import type { HistoricSession, HistoricSessionGroup } from '../../../shared/historicSessions'

export class HistoricSessions {
  private readonly projects: Pick<ProjectManager, 'listProjects' | 'listProjectSessions'>
  private readonly sessions: Pick<SessionManager, 'historyReferences' | 'localHistory'>
  private readonly models: Pick<SessionModelReader, 'read'>

  constructor(
    projects: Pick<ProjectManager, 'listProjects' | 'listProjectSessions'>,
    sessions: Pick<SessionManager, 'historyReferences' | 'localHistory'>,
    models: Pick<SessionModelReader, 'read'>,
  ) {
    this.projects = projects
    this.sessions = sessions
    this.models = models
  }

  async appJamat(lastUsedSince: number | null = null): Promise<HistoricSessionGroup[]> {
    const groups = new Map<string, Omit<HistoricSessionGroup, 'sessions'> & { sessions: Map<string, HistoricSession> }>()
    for (const entry of await this.sessions.localHistory()) {
      const key = `${entry.category.id}:${entry.project.projectName}`
      let group = groups.get(key)
      if (!group) {
        group = {
          root: entry.category,
          project: { name: entry.project.projectName, path: entry.project.projectPath },
          sessions: new Map(),
        }
        groups.set(key, group)
      }
      const id = `${entry.agentId}:${entry.nativeSessionId}`
      const row: HistoricSession = {
        agentId: entry.agentId, nativeSessionId: entry.nativeSessionId,
        title: entry.title, model: entry.model, firstUserMessage: null,
        createdAt: entry.createdAt, lastActivity: entry.lastActivity, active: entry.active,
      }
      const previous = group.sessions.get(id)
      const preferred = previous && (previous.active && !row.active
        || previous.active === row.active && (previous.lastActivity ?? 0) > (row.lastActivity ?? 0)) ? previous : row
      group.sessions.set(id, {
        ...preferred,
        createdAt: Math.min(row.createdAt, previous?.createdAt ?? row.createdAt),
        lastActivity: Math.max(row.lastActivity ?? 0, previous?.lastActivity ?? 0) || null,
      })
    }
    return [...groups.values()].map(({ root, project, sessions }) => ({
      root, project,
      sessions: [...sessions.values()].filter((row) => lastUsedSince === null
        || row.lastActivity !== null && row.lastActivity >= lastUsedSince),
    })).filter((group) => group.sessions.length > 0)
  }

  async project(categoryId: string, projectName: string, lastUsedSince: number | null = null): Promise<ProjectsOpResult<HistoricSession[]>> {
    const projects = await this.projects.listProjects(categoryId)
    if (!projects.ok) return projects
    const project = projects.value.projects.find((entry) => entry.name === projectName)
    if (!project)
      return { ok: false, code: 'project-not-found', detail: `Project is no longer available: ${projectName}` }
    const history = await this.projects.listProjectSessions(categoryId, projectName, { limit: Number.MAX_SAFE_INTEGER })
    if (!history.ok) return history
    const summaries = history.value.merged.filter((summary) => lastUsedSince === null || summary.lastActivity >= lastUsedSince)
    if (summaries.length === 0) return { ok: true, value: [] }
    const local = await this.sessions.historyReferences({ mode: 'project', categoryId, projectPath: project.path })
    if (!local.ok) throw new Error(local.detail)
    const references = new Map<string, typeof local.value.references[number]>()
    for (const row of local.value.references) {
      const key = `${row.agentId}:${row.nativeSessionId}`
      const previous = references.get(key)
      if (previous?.life !== 'live' && previous?.life !== 'starting') references.set(key, row)
    }
    const rows: HistoricSession[] = []
    for (const summary of summaries) {
      const reference = references.get(`${summary.agentId}:${summary.nativeSessionId}`)
      const model = await this.models.read({
        agentId: summary.agentId,
        cwd: project.path,
        nativeSessionId: summary.nativeSessionId,
        launchModel: null,
      })
      let modelName: string | null
      if (model.kind === 'ok') modelName = model.info.model
      else if (model.kind === 'none') modelName = null
      else throw new Error(`Unknown model reading: ${JSON.stringify(model)}`)
      rows.push({
        ...summary,
        title: reference?.title ?? summary.title,
        active: summary.active || reference?.life === 'live' || reference?.life === 'starting',
        model: modelName,
      })
    }
    return { ok: true, value: rows }
  }
}
