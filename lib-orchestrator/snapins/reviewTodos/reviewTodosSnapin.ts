import { ErrorText } from '../../shared/errorText'
import type { SnapinDefinition, SnapinContext, SnapinItem, AttemptRecord, LaunchSpec } from '../shared/snapinContract'
import { WorktreeEnding } from '../shared/worktreeEnding'
import type { SnapinKindValues, SnapinField, PassMode } from '../snapinsApi.types'
import { TodoFiles } from './todoFiles'

export class ReviewTodosSnapin implements SnapinDefinition {
  readonly kind: string
  readonly title: string
  readonly colour: SnapinDefinition['colour']
  readonly menuOrder: number
  readonly settings: SnapinDefinition['settings']

  constructor() {
    this.kind = 'review-todos'
    this.title = 'Review todos'
    this.colour = 'cyan'
    this.menuOrder = 20
    this.settings = {
      fields: async (values: SnapinKindValues, ctx: SnapinContext): Promise<SnapinField[]> => {
        const rows = []
        for (const project of await ctx.projects.projects())
          if (await TodoFiles.discover(project) !== null) rows.push({ key: TodoFiles.projectKey(project), label: project.projectPath,
            value: this.mode(values, TodoFiles.projectKey(project)) })
        return [{ kind: 'choicePerRow', id: 'modes', label: 'Project mode', rows,
          options: [{ value: 'wt', label: 'WT' }, { value: 'wc', label: 'WC' }] }]
      },
      validate: (values: SnapinKindValues): string | null => {
        if (values.modes === undefined) return null
        if (typeof values.modes !== 'object' || values.modes === null || Array.isArray(values.modes)
          || Object.values(values.modes).some((value) => value !== 'wt' && value !== 'wc')) return 'Project modes must be wt or wc'
        return null
      },
    }
  }

  async list(ctx: SnapinContext, values: SnapinKindValues): ReturnType<SnapinDefinition['list']> {
    try {
      const items = []
      for (const project of await ctx.projects.projects()) {
        const names = await TodoFiles.discover(project)
        if (names !== null) items.push(...await TodoFiles.read(project, names, ctx, this.mode(values, TodoFiles.projectKey(project))))
      }
      return { ok: true, items }
    } catch (error) { return { ok: false, detail: ErrorText.of(error) } }
  }

  async launchSpec(ctx: SnapinContext, _values: SnapinKindValues, item: SnapinItem, attemptId: string): Promise<LaunchSpec | { hold: string }> {
    if (item.hold) return { hold: item.hold }
    const fileName = String(item.payload.fileName)
    const name = TodoFiles.name(fileName)
    if (!name) return { hold: 'Todo filename is no longer valid' }
    const hold = await TodoFiles.launchHold(ctx, String(item.payload.projectPath), fileName, item.mode)
    if (hold !== null) return { hold }
    return { directory: { mode: 'project', categoryId: String(item.payload.categoryId), projectPath: String(item.payload.projectPath) },
      title: `Todo ${name.id}: ${name.slug.replace(/-/g, ' ')}`, number: `r${name.id}`,
      ...(item.mode === 'wt' ? { worktreeSlug: attemptId.slice(0, 8) } : {}),
      work: { kind: 'todo', todoId: name.id, relativePath: `.aidocs/review-todos/${fileName}` } }
  }

  async evidence(ctx: SnapinContext, attempt: AttemptRecord): ReturnType<SnapinDefinition['evidence']> {
    const id = attempt.itemKey.slice(attempt.itemKey.lastIndexOf(':') + 1)
    const url = await ctx.svn.urlOf(attempt.projectDirectory)
    if (url.ok) {
      const head = await ctx.svn.listAtHead(`${url.value.replace(/\/$/, '')}/.aidocs/review-todos`)
      if (head.ok) {
        const names = head.value.map((name) => TodoFiles.name(name)).filter((name) => name?.id === id)
        const completed = names.find((name) => name?.status === 'complete' || name?.status === 'wont_fix')
        if (completed && !names.some((name) => name?.status === 'pending' || name?.status === 'ready'))
          return { published: true, detail: completed.fileName }
      }
    }
    if (attempt.mode === 'wc') return { published: false }
    if (attempt.mode !== 'wt') throw new Error(`Unknown pass mode ${attempt.mode satisfies never}`)
    const session = ctx.sessions.snapshot().sessions.find((entry) => entry.sessionId === attempt.sessionId || entry.callerOperationId === attempt.attemptId)
    if (session?.worktree?.kind === 'git' || WorktreeEnding.of(session) === 'open') return { published: false }
    const results = await ctx.sessions.worktreeResults({ tag: attempt.attemptId })
    if (results.ok && results.value.results.some((result) => result.tag === attempt.attemptId
      && (result.result === 'discarded' || result.result === 'nothing' || result.result === 'never-started'))) return { discarded: true }
    return { published: false }
  }

  solveAllOrder(items: SnapinItem[]): SnapinItem[] {
    const ordered = []
    for (const priority of ['p0', 'p1', 'p2', 'p3']) {
      const groups = new Map<string, SnapinItem[]>()
      for (const item of items.filter((item) => item.payload.priority === priority).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })))
        groups.set(item.projectDirectory, [...groups.get(item.projectDirectory) ?? [], item])
      while ([...groups.values()].some((group) => group.length))
        for (const group of groups.values()) {
          const item = group.shift()
          if (item) ordered.push(item)
        }
    }
    return ordered
  }

  async press(): ReturnType<SnapinDefinition['press']> { return { ok: false, code: 'unknown-action' } }

  private mode(values: SnapinKindValues, key: string): PassMode {
    const mode = typeof values.modes === 'object' ? values.modes[key] : undefined
    if (mode === undefined || mode === 'wt') return 'wt'
    if (mode === 'wc') return 'wc'
    throw new Error(`Unknown project mode ${mode}`)
  }
}
