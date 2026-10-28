import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import type { SnapinContext, SnapinItem } from '../shared/snapinContract'
import type { PassMode, SnapinProjectsPort } from '../snapinsApi.types'

type Project = Awaited<ReturnType<SnapinProjectsPort['projects']>>[number]
type TodoName = { fileName: string; id: string; status: string; priority: string; slug: string }

export class TodoFiles {
  static directory(project: Pick<Project, 'projectPath'>): string { return join(project.projectPath, '.aidocs', 'review-todos') }
  static projectKey(project: Project): string { return PathCompare.comparable(project.projectPath) }
  static name(fileName: string): TodoName | null {
    const match = /^(\d{3,})-([^-]+)-(p[0-3])-(.+)\.md$/.exec(fileName)
    return match ? { fileName, id: match[1], status: match[2], priority: match[3], slug: match[4] } : null
  }

  static async discover(project: Project): Promise<string[] | null> {
    try { return (await readdir(this.directory(project), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Files only: the SVN preconditions are read by `launchHold` for the one todo being started. */
  static async read(project: Project, names: string[], ctx: SnapinContext, mode: PassMode): Promise<SnapinItem[]> {
    const projectDirectory = project.projectPath
    const key = this.projectKey(project)
    const base = { group: relative(project.categoryPath, project.projectPath).replace(/\\/g, '/') || project.projectPath, mode, projectDirectory, actions: [] }
    const byId = new Map<string, TodoName[]>()
    for (const fileName of names) {
      const name = this.name(fileName)
      if (!name) { ctx.log(`Skipped review todo outside filename pattern: ${join(this.directory(project), fileName)}`); continue }
      byId.set(name.id, [...byId.get(name.id) ?? [], name])
    }
    const items: SnapinItem[] = []
    for (const [id, files] of byId) {
      const name = files[0]
      const item: SnapinItem = { ...base, key: `review-todos:${key}:${id}`, title: `Todo ${id}: ${name.slug.replace(/-/g, ' ')}`,
        selectable: true, payload: { fileName: name.fileName, categoryId: project.categoryId, projectPath: project.projectPath, priority: name.priority } }
      if (files.length > 1) {
        items.push({ ...item, title: `Duplicate id ${id}`, hold: files.map((file) => file.fileName).join(', '), selectable: false })
        continue
      }
      const content = await readFile(join(this.directory(project), name.fileName), 'utf8')
      const status = this.canonicalStatus(this.field(content, 'status'))
      const priority = this.field(content, 'priority')
      if (!['pending', 'ready'].includes(name.status) && status !== 'pending' && status !== 'ready'
        && ['complete', 'wont_fix'].includes(name.status) && (status === 'complete' || status === 'wont_fix')) continue
      if (status === undefined) item.hold = 'status missing'
      else if (!['pending', 'ready', 'complete', 'wont_fix'].includes(status)) item.hold = `unknown status ${status}`
      else if (status !== name.status) item.hold = `status drift: file ${name.status}, frontmatter ${status}`
      else if (priority !== name.priority) item.hold = `priority drift: file ${name.priority}, frontmatter ${priority ?? 'missing'}`
      else if (mode === 'wt' && ctx.sessions.versioningMode() === 'git')
        item.hold = 'Versioning mode Git makes Git worktrees: use WC or switch Settings → Versioning to checkpoints'
      items.push(item)
    }
    return items.sort((a, b) => String(a.payload.priority).localeCompare(String(b.payload.priority)) || a.key.localeCompare(b.key, undefined, { numeric: true }))
  }

  /**
   * Why the todo cannot start, or null. Completion is proven at SVN HEAD in both modes, so the
   * project needs a working copy; a WT worktree is checked out from HEAD, so its todo file must be
   * committed there and unchanged in the main copy.
   */
  static async launchHold(ctx: SnapinContext, projectPath: string, fileName: string, mode: PassMode): Promise<string | null> {
    const url = await ctx.svn.urlOf(projectPath)
    if (!url.ok) return url.code === 'not-a-working-copy' ? 'no SVN working copy' : url.detail
    if (mode === 'wc') return null
    else if (mode !== 'wt') throw new Error(`Unknown pass mode ${mode satisfies never}`)
    const listed = await ctx.svn.listAtHead(`${url.value.replace(/\/$/, '')}/.aidocs/review-todos`)
    if (!listed.ok) return listed.detail
    if (!listed.value.includes(fileName)) {
      const id = this.name(fileName)?.id
      const published = listed.value.map((file) => this.name(file)).filter((file) => file?.id === id)
      const terminal = published.some((file) => file?.status === 'complete' || file?.status === 'wont_fix')
        && !published.some((file) => file?.status === 'pending' || file?.status === 'ready')
      return terminal ? 'Published in SVN; update the main copy to receive the completed task' : 'not committed'
    }
    const status = await ctx.svn.changedNames(this.directory({ projectPath }))
    if (!status.ok) return status.detail
    return status.value.some((path) => path === fileName || path === '.') ? 'local changes not committed' : null
  }

  private static field(content: string, field: string): string | undefined {
    const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]
    const value = frontmatter?.match(new RegExp(`^${field}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1].trim()
    return value?.replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim() || undefined
  }

  private static canonicalStatus(status: string | undefined): string | undefined {
    switch (status) {
      case 'resolved': case 'fixed': case 'done': return 'complete'
      case 'wontfix': case "won't fix": case 'skip': return 'wont_fix'
      case 'open': case 'new': return 'pending'
      case 'approved': return 'ready'
      default: return status
    }
  }
}
