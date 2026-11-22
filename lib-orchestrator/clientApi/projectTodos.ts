export type ProjectTodoColor = (typeof ProjectTodos.colorsConst)[number]

/** One task of a project's todo list, as one line of `.aidocs/todolist.jsonl`. */
export interface ProjectTodoItem {
  id: string
  title: string
  /** Absent when empty. */
  comment?: string
  /** Free text a person typed; absent when empty. */
  category?: string
  /** One colour of the palette `ProjectTodos.colorsConst`; absent when none. */
  color?: ProjectTodoColor
  /** The operating-system user who added the task; absent on a task written by hand. */
  author?: string
  done: boolean
  /** ISO 8601, written by the orchestrator's clock. */
  created: string
  /** ISO 8601; present only while `done`. */
  doneAt?: string
}

/**
 * What a list shows. `text` words must all occur in title, comment, category or author; a `#name`
 * word asks for that category and an `@name` word for that author. `category: ''` means tasks
 * without a category, `color: ''` tasks without a colour. `done` absent shows both open and done tasks.
 */
export interface ProjectTodosQuery {
  text?: string
  category?: string
  color?: string
  author?: string
  done?: boolean
}

export interface ProjectTodosCount {
  name: string
  count: number
}

export interface ProjectTodosSnapshot {
  /** The catalog project the list belongs to: the main copy, also for a worktree session. */
  project: string
  file: string
  /** The operating-system user this computer records as the author of a new task. */
  user: string
  /** The tasks the query asked for, in display order; every task when no query was given. */
  items: readonly ProjectTodoItem[]
  /** Every task of the file, whatever the query. */
  total: number
  categories: readonly ProjectTodosCount[]
  /** In palette order. */
  colors: readonly ProjectTodosCount[]
  authors: readonly ProjectTodosCount[]
}

/**
 * One change. The orchestrator applies it to the list it reads from disk at that moment, so an
 * agent's edit or an `svn update` between two changes is never written over. An `add` without an
 * id gets one from the orchestrator; an `edit` changes only the fields it names. `color: ''` is no colour.
 */
export type ProjectTodoOperation =
  | { kind: 'add'; id?: string; title: string; category?: string; comment?: string; color?: ProjectTodoColor | '' }
  | { kind: 'edit'; id: string; title?: string; category?: string; comment?: string; color?: ProjectTodoColor | '' }
  | { kind: 'toggle'; id: string; done: boolean }
  | { kind: 'remove'; id: string }
  | { kind: 'restore'; item: ProjectTodoItem }

/** `invalid-target` names neither or both of session and project; `session-*` and `unknown-session` are about the session named. */
export type ProjectTodosReadRefusal =
  | 'invalid-target' | 'session-not-found' | 'session-ambiguous' | 'unknown-session' | 'no-project'
  | 'file-conflict' | 'file-damaged' | 'file-unreadable'

export type ProjectTodosListResult =
  | { ok: true; value: ProjectTodosSnapshot }
  | { ok: false; code: ProjectTodosReadRefusal; detail: string }

export type ProjectTodosApplyResult =
  | { ok: true; value: ProjectTodosSnapshot }
  | { ok: false; code: ProjectTodosReadRefusal | 'invalid-operation' | 'write-failed'; detail: string }

/** `not-removed`: this orchestrator removed no task with that id since it started, or it was put back already. */
export type ProjectTodosRestoreResult =
  | { ok: true; value: ProjectTodosSnapshot }
  | { ok: false; code: ProjectTodosReadRefusal | 'invalid-operation' | 'write-failed' | 'not-removed'; detail: string }

/** Where a session's todo list opens: the split beside its terminal, or the File Tools sidebar tab. */
export type ProjectTodosPlace = 'split' | 'sidebar'

export type ProjectTodosParseResult =
  | { ok: true; items: readonly ProjectTodoItem[] }
  | { ok: false; conflict: boolean; detail: string }

export type ProjectTodosStep =
  | { ok: true; items: readonly ProjectTodoItem[] }
  | { ok: false; detail: string }

/** What an applied change stamps: the time of an added or completed task and who added it. */
export interface ProjectTodosStamp {
  now: string
  author: string
}

/**
 * The rules of a project's todo list: the file, the limits, the one way a change is applied and the
 * one way a list is filtered. Shared because the window applies the same change at once to what it
 * shows, and filters as the API does. No imports, no clock, no I/O.
 *
 * **The file is written for version control merges.** One task per line, lines sorted by id, a blank
 * line between two tasks. Two people who change two different tasks change two lines with an
 * unchanged line between them, which a three-way merge joins; a task added on each side lands at a
 * random place, because ids are random. Only two changes of one task meet in one conflict.
 */
export class ProjectTodos {
  static readonly fileRelativeConst = '.aidocs/todolist.jsonl'
  static readonly formatConst = 'jamat-todolist'
  static readonly versionConst = 1
  static readonly itemsMaxConst = 500
  static readonly titleMaxConst = 200
  static readonly categoryMaxConst = 40
  static readonly authorMaxConst = 64
  static readonly commentMaxConst = 20_000
  /** Names, not values: the file keeps the name and each view draws its own shade. */
  static readonly colorsConst = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'magenta'] as const
  private static readonly idMaxConst = 64
  private static readonly conflictPattern = /^(<{7}|={7}|>{7}|\|{7})( |$)/m

  /** An empty text is an empty list; anything that is not a readable list is refused, never emptied. */
  static parse(text: string): ProjectTodosParseResult {
    if (ProjectTodos.conflictPattern.test(text))
      return { ok: false, conflict: true, detail: 'The file holds an unresolved version control conflict' }
    const lines = text.split(/\r?\n/).map((line, index) => ({ line: line.trim(), number: index + 1 })).filter((entry) => entry.line !== '')
    if (lines.length === 0) return { ok: true, items: [] }
    const header = ProjectTodos.json(lines[0].line)
    if (!ProjectTodos.isRecord(header) || header.format !== ProjectTodos.formatConst)
      return { ok: false, conflict: false, detail: `Line ${lines[0].number} is not the header {"format":"${ProjectTodos.formatConst}",...}` }
    if (header.version !== ProjectTodos.versionConst)
      return { ok: false, conflict: false, detail: `The file has version ${JSON.stringify(header.version)}; this build reads version ${ProjectTodos.versionConst}` }
    const items: ProjectTodoItem[] = []
    for (const entry of lines.slice(1)) {
      const item = ProjectTodos.itemOf(ProjectTodos.json(entry.line))
      if (item === null) return { ok: false, conflict: false, detail: `Line ${entry.number} is not a readable task` }
      items.push(item)
    }
    const problem = ProjectTodos.problemOf(items)
    return problem === null ? { ok: true, items: ProjectTodos.sorted(items) } : { ok: false, conflict: false, detail: problem }
  }

  /** The file text: the header, then one task per line sorted by id, a blank line between tasks. */
  static serialize(items: readonly ProjectTodoItem[]): string {
    const header = JSON.stringify({ format: ProjectTodos.formatConst, version: ProjectTodos.versionConst })
    return [header, ...ProjectTodos.sorted(items).map((item) => JSON.stringify(ProjectTodos.ordered(item)))].join('\n\n') + '\n'
  }

  static problemOf(items: readonly ProjectTodoItem[]): string | null {
    if (items.length > ProjectTodos.itemsMaxConst) return `A todo list holds at most ${ProjectTodos.itemsMaxConst} tasks`
    const ids = new Set<string>()
    for (const item of items) {
      if (ids.has(item.id)) return `Two tasks share the id ${JSON.stringify(item.id)}`
      ids.add(item.id)
      const problem = ProjectTodos.fieldsProblemOf(item.title, item.category ?? '', item.comment ?? '')
      if (problem !== null) return problem
    }
    return null
  }

  /** The change applied to `items`. An add must carry its id here; the orchestrator gives one first. */
  static applied(items: readonly ProjectTodoItem[], operation: ProjectTodoOperation, stamp: ProjectTodosStamp): ProjectTodosStep {
    const shape = ProjectTodos.operationProblemOf(operation)
    if (shape !== null) return { ok: false, detail: shape }
    let next: readonly ProjectTodoItem[]
    if (operation.kind === 'add') {
      const id = operation.id
      if (id === undefined) return { ok: false, detail: 'A new task needs an id' }
      if (items.some((item) => item.id === id)) return { ok: false, detail: 'The task already exists' }
      const author = stamp.author.slice(0, ProjectTodos.authorMaxConst)
      next = [...items, ProjectTodos.withFields({ id, title: '', ...(author === '' ? {} : { author }), done: false, created: stamp.now },
        { title: operation.title, category: operation.category ?? '', comment: operation.comment ?? '', color: operation.color ?? '' })]
    }
    else if (operation.kind === 'edit') {
      const step = ProjectTodos.changed(items, operation.id, (item) => ProjectTodos.withFields(item, {
        title: operation.title ?? item.title,
        category: operation.category ?? item.category ?? '',
        comment: operation.comment ?? item.comment ?? '',
        color: operation.color ?? item.color ?? '',
      }))
      if (!step.ok) return step
      next = step.items
    }
    else if (operation.kind === 'toggle') {
      const step = ProjectTodos.changed(items, operation.id, (item) => {
        if (item.done === operation.done) return item
        const { doneAt: _doneAt, ...open } = item
        return operation.done ? { ...open, done: true, doneAt: stamp.now } : { ...open, done: false }
      })
      if (!step.ok) return step
      next = step.items
    }
    else if (operation.kind === 'remove') {
      if (!items.some((item) => item.id === operation.id)) return { ok: false, detail: 'The task no longer exists' }
      next = items.filter((item) => item.id !== operation.id)
    }
    else if (operation.kind === 'restore') {
      const restored = ProjectTodos.itemOf(operation.item)
      if (restored === null) return { ok: false, detail: 'The restored task is not readable' }
      if (items.some((item) => item.id === restored.id)) return { ok: true, items }
      next = [...items, restored]
    }
    else throw new Error(`Unknown todo operation: ${JSON.stringify(operation satisfies never)}`)
    const problem = ProjectTodos.problemOf(next)
    return problem === null ? { ok: true, items: ProjectTodos.sorted(next) } : { ok: false, detail: problem }
  }

  /** The wire hands in any object; this is the one check of what an operation may hold. */
  static operationProblemOf(operation: unknown): string | null {
    if (!ProjectTodos.isRecord(operation)) return 'The operation must be an object'
    const kind = operation.kind
    if (kind === 'add') {
      if (operation.id !== undefined && !ProjectTodos.isId(operation.id)) return 'The task id is not valid'
      if (typeof operation.title !== 'string' || operation.title.trim() === '') return 'A new task needs a title'
      if (!ProjectTodos.optionalText(operation.category) || !ProjectTodos.optionalText(operation.comment))
        return 'A category and a comment are text'
      if (!ProjectTodos.optionalColor(operation.color)) return ProjectTodos.colorProblem()
      return ProjectTodos.fieldsProblemOf(operation.title, operation.category ?? '', operation.comment ?? '')
    }
    else if (kind === 'edit') {
      if (!ProjectTodos.isId(operation.id)) return 'The task id is not valid'
      if (!ProjectTodos.optionalText(operation.title) || !ProjectTodos.optionalText(operation.category) || !ProjectTodos.optionalText(operation.comment))
        return 'A title, a category and a comment are text'
      if (!ProjectTodos.optionalColor(operation.color)) return ProjectTodos.colorProblem()
      if (operation.title === undefined && operation.category === undefined && operation.comment === undefined && operation.color === undefined)
        return 'An edit names a title, a category, a comment or a colour'
      return ProjectTodos.fieldsProblemOf(operation.title ?? '', operation.category ?? '', operation.comment ?? '')
    }
    else if (kind === 'toggle')
      return ProjectTodos.isId(operation.id) && typeof operation.done === 'boolean' ? null : 'A toggle needs a task id and done'
    else if (kind === 'remove')
      return ProjectTodos.isId(operation.id) ? null : 'The task id is not valid'
    else if (kind === 'restore') {
      const item = ProjectTodos.itemOf(operation.item)
      return item === null ? 'The restored task is not readable' : ProjectTodos.fieldsProblemOf(item.title, item.category ?? '', item.comment ?? '')
    }
    else return `Unknown todo operation: ${JSON.stringify(kind)}`
  }

  /** Open tasks first, then done ones; newest first in each. The one order every view and the API show. */
  static visible(items: readonly ProjectTodoItem[], query: ProjectTodosQuery = {}): readonly ProjectTodoItem[] {
    const words = ProjectTodos.folded(query.text ?? '').split(/\s+/).filter((word) => word !== '')
    const categories = words.filter((word) => word.startsWith('#') && word.length > 1).map((word) => word.slice(1))
    const authors = words.filter((word) => word.startsWith('@') && word.length > 1).map((word) => word.slice(1))
    const texts = words.filter((word) => !word.startsWith('#') && !word.startsWith('@'))
    const category = query.category === undefined ? undefined : ProjectTodos.folded(query.category.trim())
    const author = query.author === undefined ? undefined : ProjectTodos.folded(query.author)
    const color = query.color === undefined ? undefined : ProjectTodos.folded(query.color.trim())
    const shown = items.filter((item) => {
      if (query.done !== undefined && item.done !== query.done) return false
      const itemCategory = ProjectTodos.folded(item.category ?? '')
      const itemAuthor = ProjectTodos.folded(item.author ?? '')
      if (category !== undefined && itemCategory !== category) return false
      if (author !== undefined && itemAuthor !== author) return false
      if (color !== undefined && (item.color ?? '') !== color) return false
      if (categories.some((name) => name !== itemCategory) || authors.some((name) => name !== itemAuthor)) return false
      const haystack = ProjectTodos.folded(`${item.title}\n${item.comment ?? ''}\n${item.category ?? ''}\n${item.author ?? ''}`)
      return texts.every((word) => haystack.includes(word))
    })
    const newest = (a: ProjectTodoItem, b: ProjectTodoItem): number => b.created.localeCompare(a.created) || a.id.localeCompare(b.id)
    return [...shown.filter((item) => !item.done).sort(newest), ...shown.filter((item) => item.done).sort(newest)]
  }

  /** Every category with its tasks counted, sorted by name. */
  static categoriesOf(items: readonly ProjectTodoItem[]): readonly ProjectTodosCount[] {
    return ProjectTodos.countsOf(items.map((item) => item.category))
  }

  /** Every colour that tasks carry, with its tasks counted, in palette order. */
  static colorsOf(items: readonly ProjectTodoItem[]): readonly ProjectTodosCount[] {
    return ProjectTodos.colorsConst
      .map((name) => ({ name, count: items.filter((item) => item.color === name).length }))
      .filter((entry) => entry.count > 0)
  }

  static isColor(value: unknown): value is ProjectTodoColor {
    return typeof value === 'string' && (ProjectTodos.colorsConst as readonly string[]).includes(value)
  }

  /** Every author with the tasks they added, sorted by name. */
  static authorsOf(items: readonly ProjectTodoItem[]): readonly ProjectTodosCount[] {
    return ProjectTodos.countsOf(items.map((item) => item.author))
  }

  static snapshotOf(project: string, file: string, user: string, items: readonly ProjectTodoItem[], query?: ProjectTodosQuery): ProjectTodosSnapshot {
    return { project, file, user, items: ProjectTodos.visible(items, query), total: items.length,
      categories: ProjectTodos.categoriesOf(items), colors: ProjectTodos.colorsOf(items), authors: ProjectTodos.authorsOf(items) }
  }

  static folded(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  }

  private static countsOf(names: readonly (string | undefined)[]): readonly ProjectTodosCount[] {
    const counts = new Map<string, ProjectTodosCount>()
    for (const name of names) {
      if (name === undefined) continue
      const key = ProjectTodos.folded(name)
      const held = counts.get(key)
      if (held === undefined) counts.set(key, { name, count: 1 })
      else held.count += 1
    }
    return [...counts.values()].sort((a, b) => ProjectTodos.folded(a.name).localeCompare(ProjectTodos.folded(b.name)))
  }

  private static sorted(items: readonly ProjectTodoItem[]): readonly ProjectTodoItem[] {
    return [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }

  private static changed(
    items: readonly ProjectTodoItem[],
    id: string,
    change: (item: ProjectTodoItem) => ProjectTodoItem,
  ): ProjectTodosStep {
    const index = items.findIndex((item) => item.id === id)
    if (index === -1) return { ok: false, detail: 'The task no longer exists' }
    return { ok: true, items: items.map((item, at) => at === index ? change(item) : item) }
  }

  private static withFields(
    item: ProjectTodoItem,
    fields: { title: string; category: string; comment: string; color: ProjectTodoColor | '' },
  ): ProjectTodoItem {
    const { comment: _comment, category: _category, color: _color, ...rest } = item
    const category = fields.category.trim()
    return ProjectTodos.ordered({
      ...rest,
      title: fields.title,
      ...(fields.comment === '' ? {} : { comment: fields.comment }),
      ...(category === '' ? {} : { category }),
      ...(fields.color === '' ? {} : { color: fields.color }),
    })
  }

  private static fieldsProblemOf(title: string, category: string, comment: string): string | null {
    if (title.length > ProjectTodos.titleMaxConst) return `A title holds at most ${ProjectTodos.titleMaxConst} characters`
    if (category.length > ProjectTodos.categoryMaxConst) return `A category holds at most ${ProjectTodos.categoryMaxConst} characters`
    if (comment.length > ProjectTodos.commentMaxConst) return `A comment holds at most ${ProjectTodos.commentMaxConst} characters`
    if (/[\r\n]/.test(title) || /[\r\n]/.test(category)) return 'A title and a category are one line'
    return null
  }

  private static itemOf(raw: unknown): ProjectTodoItem | null {
    if (!ProjectTodos.isRecord(raw)) return null
    if (!ProjectTodos.isId(raw.id) || typeof raw.title !== 'string' || typeof raw.done !== 'boolean' || typeof raw.created !== 'string')
      return null
    for (const field of [raw.comment, raw.category, raw.author, raw.doneAt])
      if (!ProjectTodos.optionalText(field)) return null
    const category = typeof raw.category === 'string' ? raw.category.trim() : ''
    const author = typeof raw.author === 'string' ? raw.author.trim() : ''
    return ProjectTodos.ordered({
      id: raw.id,
      title: raw.title,
      ...(typeof raw.comment === 'string' && raw.comment !== '' ? { comment: raw.comment } : {}),
      ...(category === '' ? {} : { category }),
      // A colour this build does not know is dropped like an unknown key, never a reason to refuse the file.
      ...(ProjectTodos.isColor(raw.color) ? { color: raw.color } : {}),
      ...(author === '' ? {} : { author }),
      done: raw.done,
      created: raw.created,
      ...(raw.done && typeof raw.doneAt === 'string' ? { doneAt: raw.doneAt } : {}),
    })
  }

  private static ordered(item: ProjectTodoItem): ProjectTodoItem {
    return {
      id: item.id,
      title: item.title,
      ...(item.comment === undefined ? {} : { comment: item.comment }),
      ...(item.category === undefined ? {} : { category: item.category }),
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.author === undefined ? {} : { author: item.author }),
      done: item.done,
      created: item.created,
      ...(item.doneAt === undefined ? {} : { doneAt: item.doneAt }),
    }
  }

  private static json(line: string): unknown {
    try { return JSON.parse(line) }
    catch { return undefined }
  }

  private static optionalColor(value: unknown): value is ProjectTodoColor | '' | undefined {
    return value === undefined || value === '' || ProjectTodos.isColor(value)
  }

  private static colorProblem(): string {
    return `A colour is one of ${ProjectTodos.colorsConst.join(', ')}, or "" for none`
  }

  private static optionalText(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string'
  }

  private static isId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= ProjectTodos.idMaxConst && /^[A-Za-z0-9_-]+$/.test(value)
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
