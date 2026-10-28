import type { VersioningMode } from '../../../lib-orchestrator/git/git.types'
import type { ProjectManager } from '../../../lib-orchestrator/projectManager/projectManager'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SnapinPresentationPort, SnapinProjectsPort, SnapinSessionsPort, SnapinSvnPort } from '../../../lib-orchestrator/snapins/snapinsApi.types'
import type { SvnWorktreeManager } from '../../../lib-orchestrator/svn/svnWorktreeManager'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import type { RemoteSessionGroups } from '../sessionGroups/remoteSessionGroups'
import type { SessionGroupsOperations } from '../sessionGroups/sessionGroupsOperations'
import { SessionsGroupsState } from '../../shared/sessionsGroupsState'

export class SnapinsPorts {
  static presentation(input: {
    groups: Pick<RemoteSessionGroups, 'assign'>
    groupsOperations: Pick<SessionGroupsOperations, 'ensure'>
    sessions: Pick<SessionManager, 'snapshot' | 'setSessionDetails'>
  }): SnapinPresentationPort {
    return {
      ensureGroups: async () => input.groupsOperations.ensure(SessionsGroupsState.defaultsConst.filter((group) =>
        ['automation', 'waiting', 'blocked', 'completed'].includes(group.id))).ok,
      assign: (id, group) => {
        if (!input.sessions.snapshot().sessions.some((session) => session.sessionId === id)) return 'missing-session'
        const answer = input.groups.assign(id, group)
        return answer.ok ? 'ok' : answer.error.code === 'invalid-request' ? 'missing-group' : 'failed'
      },
      setNote: async (id, note) => {
        const answer = await input.sessions.setSessionDetails(id, { note })
        return answer.ok ? 'ok' : answer.code === 'not-found' ? 'missing-session' : 'failed'
      },
    }
  }

  static of(input: {
    sessions: Pick<SessionManager, 'snapshot' | 'createSession' | 'worktreeResults' | 'acknowledgeWorktreeResult'>
    svn: Pick<SvnWorktreeManager, 'urlOf' | 'listAtHead' | 'changedNames'>
    projects: Pick<ProjectManager, 'listCategories' | 'listProjects'>
    tabs: Pick<TabControlBroker, 'open'>
    versioningMode(): VersioningMode
  }): { sessions: SnapinSessionsPort; svn: SnapinSvnPort; projects: SnapinProjectsPort } {
    return {
      sessions: {
        snapshot: () => input.sessions.snapshot(),
        versioningMode: input.versioningMode,
        createSession: (spec, origin) => input.sessions.createSession(spec, origin),
        worktreeResults: (filter) => input.sessions.worktreeResults({ ...filter, includeLandingProof: false }),
        acknowledgeWorktreeResult: (id) => input.sessions.acknowledgeWorktreeResult(id),
        openTerminal: async (id) => {
          const session = input.sessions.snapshot().sessions.find((item) => item.sessionId === id)
          if (!session) return 'missing-session'
          try {
            const result = await input.tabs.open(id, session.tabTitle, { activate: true })
            return result.ok ? 'ok' : { error: result.error.detail }
          } catch (error) { return { error: ErrorText.of(error) } }
        },
      },
      svn: { urlOf: (dir) => input.svn.urlOf(dir), listAtHead: (url) => input.svn.listAtHead(url),
        changedNames: (dir) => input.svn.changedNames(dir) },
      projects: { projects: async () => {
        const projects: Awaited<ReturnType<SnapinProjectsPort['projects']>> = []
        for (const category of await input.projects.listCategories()) {
          if (!category.available) continue
          const listed = await input.projects.listProjects(category.id)
          if (!listed.ok) throw new Error(listed.detail)
          if (!listed.value.available || listed.value.truncated) throw new Error(`Project listing unavailable or truncated: ${category.path}`)
          projects.push(...listed.value.projects.map((project) => ({
            categoryId: category.id, categoryPath: category.path, projectPath: project.path,
          })))
        }
        return projects
      } },
    }
  }
}
