import type { ProjectBinding } from '../projectManager/projectManagerApi.types'
import type { SessionInfo, SessionParentKind, SessionsSnapshot } from './sessionManagerApi.types'

export interface SessionTreeEntry {
  info: Pick<SessionInfo, 'sessionId' | 'title' | 'project' | 'parent' | 'script'>
}

export interface SessionTreeNesting {
  subagents: boolean
  worktrees: boolean
  tickets: boolean
}

export interface SessionTreeParent<T> {
  parent: T
  via: 'script' | 'session'
}

export interface SessionTreeProject<T> {
  id: string
  label: string
  path: string
  launch: Extract<ProjectBinding, { kind: 'project' }> | null
  entries: T[]
}

export interface SessionTreeCategory<T> {
  id: string
  label: string
  categoryId: string | null
  projects: readonly SessionTreeProject<T>[]
  sessions: readonly T[]
}

export class SessionTreeHierarchy {
  static readonly adHocRootConst = 'root:adhoc'
  static readonly noProjectRootConst = 'root:none'
  static readonly nestedConst: SessionTreeNesting = { subagents: true, worktrees: true, tickets: true }

  static linksOf<T extends SessionTreeEntry>(
    entries: readonly T[],
    nesting: SessionTreeNesting = SessionTreeHierarchy.nestedConst,
  ): ReadonlyMap<string, SessionTreeParent<T>> {
    const byId = new Map(entries.map(entry => [entry.info.sessionId, entry]))
    const links = new Map<string, SessionTreeParent<T>>()
    for (const entry of entries) {
      const runFor = entry.info.script?.parentId
      if (runFor !== undefined) {
        const parent = byId.get(runFor)
        if (parent !== undefined && parent !== entry && parent.info.script === undefined)
          links.set(entry.info.sessionId, { parent, via: 'script' })
      } else {
        const parent = SessionTreeHierarchy.ownParentOf(entry, byId, nesting)
        // One session hop prevents cycles; a script may still sit below that session child.
        if (parent !== undefined && SessionTreeHierarchy.ownParentOf(parent, byId, nesting) === undefined)
          links.set(entry.info.sessionId, { parent, via: 'session' })
      }
    }
    return links
  }

  static childrenByParent<T extends SessionTreeEntry>(
    entries: readonly T[],
    links: ReadonlyMap<string, SessionTreeParent<T>>,
  ): Map<string, T[]> {
    const shown = new Set(entries.map(entry => entry.info.sessionId))
    const children = new Map<string, T[]>()
    for (const entry of entries) {
      const parentId = links.get(entry.info.sessionId)?.parent.info.sessionId
      if (parentId !== undefined && shown.has(parentId))
        children.set(parentId, [...(children.get(parentId) ?? []), entry])
    }
    return children
  }

  static sectionOf<T extends SessionTreeEntry>(entry: T, links: ReadonlyMap<string, SessionTreeParent<T>>): T {
    const first = links.get(entry.info.sessionId)?.parent
    return first === undefined ? entry : links.get(first.info.sessionId)?.parent ?? first
  }

  static categories<T extends SessionTreeEntry>(
    roots: readonly T[],
    catalog: SessionsSnapshot['categories'],
  ): readonly SessionTreeCategory<T>[] {
    const categories = new Map<string, { label: string; projects: Map<string, SessionTreeProject<T>> }>()
    const adHoc = new Map<string, SessionTreeProject<T>>()
    const loose: T[] = []
    for (const entry of roots) {
      const binding = entry.info.project
      const group = SessionTreeHierarchy.projectGroupOf(binding)
      if (binding.kind === 'project') {
        let category = categories.get(binding.categoryId)
        if (category === undefined) {
          category = { label: catalog.find(c => c.id === binding.categoryId)?.label ?? binding.categoryId, projects: new Map() }
          categories.set(binding.categoryId, category)
        }
        SessionTreeHierarchy.push(category.projects, group.rootId,
          { path: binding.projectPath, label: binding.projectName, launch: binding }, entry)
      } else if (binding.kind === 'adHoc')
        SessionTreeHierarchy.push(adHoc, group.rootId,
          { path: binding.path, label: binding.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || binding.path, launch: null }, entry)
      else if (binding.kind === 'none')
        loose.push(entry)
      else
        throw new Error(`Unknown project binding: ${JSON.stringify(binding)}`)
    }
    const index = (id: string): number => {
      const found = catalog.findIndex(c => c.id === id)
      return found < 0 ? catalog.length : found
    }
    const ordered = (projects: Map<string, SessionTreeProject<T>>): SessionTreeProject<T>[] =>
      [...projects.values()].sort((a, b) => a.label.localeCompare(b.label))
    const nodes: SessionTreeCategory<T>[] = [...categories.entries()]
      .sort(([a], [b]) => index(a) - index(b))
      .map(([id, category]) => ({ id: `category:${id}`, categoryId: id, label: category.label,
        projects: ordered(category.projects), sessions: [] }))
    if (adHoc.size > 0)
      nodes.push({ id: SessionTreeHierarchy.adHocRootConst, categoryId: null, label: 'AD-HOC', projects: ordered(adHoc), sessions: [] })
    if (loose.length > 0)
      nodes.push({ id: SessionTreeHierarchy.noProjectRootConst, categoryId: null, label: 'NO PROJECT', projects: [], sessions: loose })
    return nodes
  }

  static sorted<T extends SessionTreeEntry>(entries: readonly T[]): readonly T[] {
    return [...entries].sort((a, b) => a.info.title.localeCompare(b.info.title)
      || a.info.sessionId.localeCompare(b.info.sessionId))
  }

  static projectGroupOf(binding: ProjectBinding): { rootId: string; path: string | null } {
    if (binding.kind === 'project') return { rootId: `category:${binding.categoryId}`, path: binding.projectPath }
    else if (binding.kind === 'adHoc') return { rootId: SessionTreeHierarchy.adHocRootConst, path: binding.path }
    else if (binding.kind === 'none') return { rootId: SessionTreeHierarchy.noProjectRootConst, path: null }
    else throw new Error(`Unknown project binding: ${JSON.stringify(binding)}`)
  }

  static projectKeyOf(rootId: string, path: string): string {
    const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
    return `project:${rootId}/${/^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized}`
  }

  static projectTextOf(project: ProjectBinding): string {
    if (project.kind === 'project') return `${project.projectName} ${project.projectPath}`
    else if (project.kind === 'adHoc') return project.path
    else if (project.kind === 'none') return ''
    else throw new Error(`Unknown project binding: ${JSON.stringify(project)}`)
  }

  private static push<T extends SessionTreeEntry>(
    projects: Map<string, SessionTreeProject<T>>,
    rootId: string,
    seed: Omit<SessionTreeProject<T>, 'id' | 'entries'>,
    entry: T,
  ): void {
    const id = SessionTreeHierarchy.projectKeyOf(rootId, seed.path)
    const found = projects.get(id)
    if (found !== undefined)
      found.entries.push(entry)
    else
      projects.set(id, { ...seed, id, entries: [entry] })
  }

  private static ownParentOf<T extends SessionTreeEntry>(
    entry: T,
    byId: ReadonlyMap<string, T>,
    nesting: SessionTreeNesting,
  ): T | undefined {
    const link = entry.info.parent
    if (link === undefined || !link.sameProject || !SessionTreeHierarchy.nests(link.kind, nesting))
      return undefined
    const parent = byId.get(link.sessionId)
    return parent === undefined || parent === entry || parent.info.script !== undefined ? undefined : parent
  }

  private static nests(kind: SessionParentKind, nesting: SessionTreeNesting): boolean {
    switch (kind) {
      case 'worktree': return nesting.worktrees
      case 'ticket': return nesting.tickets
      case 'worker': return nesting.subagents
      default: throw new Error(`Unknown session parent kind: ${JSON.stringify(kind)}`)
    }
  }
}
