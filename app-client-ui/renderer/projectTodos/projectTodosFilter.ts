import { ProjectTodos, type ProjectTodoColor, type ProjectTodoItem, type ProjectTodosQuery } from '../../shared/projectTodos'

/** `all` shows every category, `none` only tasks without one. */
export type ProjectTodosCategoryFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'named'; name: string }

export interface ProjectTodosFilterState {
  query: string
  category: ProjectTodosCategoryFilter
  /** Null shows every author. */
  author: string | null
  /** Null shows every colour, `''` only tasks without one. */
  color: string | null
  showDone: boolean
}

/**
 * A view's filter, as the view holds it, and its translation into the one query every view and the
 * API share (`ProjectTodos.visible`). What stays here is the view's own: colours and fallbacks.
 */
export class ProjectTodosFilter {
  static readonly tonesConst = ['blue', 'green', 'amber', 'violet', 'teal', 'rose', 'orange', 'cyan'] as const

  static initial(): ProjectTodosFilterState {
    return { query: '', category: { kind: 'all' }, author: null, color: null, showDone: true }
  }

  static visible(items: readonly ProjectTodoItem[], filter: ProjectTodosFilterState): readonly ProjectTodoItem[] {
    return ProjectTodos.visible(items, ProjectTodosFilter.queryOf(filter))
  }

  static queryOf(filter: ProjectTodosFilterState): ProjectTodosQuery {
    const category = filter.category
    let named: string | undefined
    if (category.kind === 'all') named = undefined
    else if (category.kind === 'none') named = ''
    else if (category.kind === 'named') named = category.name
    else throw new Error(`Unknown category filter: ${JSON.stringify(category satisfies never)}`)
    return {
      ...(filter.query.trim() === '' ? {} : { text: filter.query }),
      ...(named === undefined ? {} : { category: named }),
      ...(filter.author === null ? {} : { author: filter.author }),
      ...(filter.color === null ? {} : { color: filter.color }),
      ...(filter.showDone ? {} : { done: false }),
    }
  }

  static uncategorizedOf(items: readonly ProjectTodoItem[]): number {
    return items.filter((item) => item.category === undefined).length
  }

  /** A stable colour per category name, so nothing has to be configured. */
  static toneOf(category: string): (typeof ProjectTodosFilter.tonesConst)[number] {
    let hash = 0
    for (const char of ProjectTodos.folded(category)) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
    return ProjectTodosFilter.tonesConst[hash % ProjectTodosFilter.tonesConst.length]
  }

  static uncoloredOf(items: readonly ProjectTodoItem[]): number {
    return items.filter((item) => item.color === undefined).length
  }

  /** A filter on a category, an author or a colour that no task carries any more falls back to all. */
  static settled(filter: ProjectTodosFilterState, items: readonly ProjectTodoItem[]): ProjectTodosFilterState {
    const has = (value: string | undefined, name: string): boolean => value !== undefined && ProjectTodos.folded(value) === ProjectTodos.folded(name)
    const category = filter.category
    const keepsCategory = category.kind !== 'named' || items.some((item) => has(item.category, category.name))
    const author = filter.author
    const keepsAuthor = author === null || items.some((item) => has(item.author, author))
    const color = filter.color
    const keepsColor = color === null || color === '' || items.some((item) => item.color === color)
    if (keepsCategory && keepsAuthor && keepsColor) return filter
    return { ...filter, category: keepsCategory ? category : { kind: 'all' }, author: keepsAuthor ? author : null, color: keepsColor ? color : null }
  }

  /** The colour a new task takes from the filter in front of it, so it stays in view. */
  static colorForNew(filter: ProjectTodosFilterState): ProjectTodoColor | '' {
    return ProjectTodos.isColor(filter.color) ? filter.color : ''
  }

  /** The category a new task takes from the filter in front of it. */
  static categoryForNew(filter: ProjectTodosFilterState): string {
    const category = filter.category
    if (category.kind === 'named') return category.name
    else if (category.kind === 'all' || category.kind === 'none') return ''
    else throw new Error(`Unknown category filter: ${JSON.stringify(category satisfies never)}`)
  }
}
