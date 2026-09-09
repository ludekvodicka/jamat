import type { ProjectManager } from '../../../lib-orchestrator/projectManager/projectManager'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/**
 * The ProjectManager's share of the named allowlist. Every handler is one delegation: what a rename
 * means lives in the library, and a rule that lived here too would be a rule the smoke run cannot
 * reach.
 */
export class ServiceProjectsIpc extends ServiceIpcBase<typeof ServiceProjectsIpc.channelsConst> {
  static readonly channelsConst = {
    'projects:config-get': true,
    'projects:config-save': true,
    'projects:categories': true,
    'projects:list': true,
    'projects:sessions': true,
    'projects:create': true,
    'projects:rename': true,
    'projects:move-prefix': true,
    'projects:archive': true,
    'projects:delete-preview': true,
    'projects:delete': true,
  } as const

  constructor(private readonly projects: ProjectManager) {
    super()
  }

  initialize(): void {
    this.register('projects:config-get', () => this.projects.getConfig())
    this.register('projects:config-save', (_event, categories) =>
      this.projects.saveConfig(categories))
    this.register('projects:categories', () => this.projects.listCategories())
    this.register('projects:list', (_event, categoryId, sort) =>
      this.projects.listProjects(categoryId, { sort }))
    this.register('projects:sessions', (_event, categoryId, projectName) =>
      this.projects.listProjectSessions(categoryId, projectName))
    this.register('projects:create', (_event, categoryId, name, virtualFolderPrefix) =>
      this.projects.createProject(
        categoryId,
        name,
        virtualFolderPrefix === null ? undefined : { virtualFolderPrefix },
      ))
    this.register('projects:rename', (_event, categoryId, oldName, newName) =>
      this.projects.renameProject(categoryId, oldName, newName))
    this.register('projects:move-prefix', (_event, categoryId, name, targetPrefix) =>
      this.projects.moveProjectPrefix(categoryId, name, targetPrefix))
    this.register('projects:archive', (_event, categoryId, name) =>
      this.projects.archiveProject(categoryId, name))
    this.register('projects:delete-preview', (_event, categoryId, name) =>
      this.projects.previewDelete(categoryId, name))
    this.register('projects:delete', (_event, token) => this.projects.executeDelete(token))
    this.assertComplete(ServiceProjectsIpc.channelsConst)
  }
}
