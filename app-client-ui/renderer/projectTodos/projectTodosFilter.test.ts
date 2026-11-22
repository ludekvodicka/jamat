import { describe, expect, it } from 'vitest'

import type { ProjectTodoItem } from '../../shared/projectTodos'
import { ProjectTodosFilter } from './projectTodosFilter'

describe('app-client-ui/renderer/projectTodos/projectTodosFilter', () => {
  const created = '2026-11-21T10:00:00.000Z'
  const items: ProjectTodoItem[] = [
    { id: 'o1', title: 'Sidebar', category: 'ui', author: 'dana', done: false, created },
    { id: 'o2', title: 'Loose end', author: 'eva', done: false, created },
    { id: 'd1', title: 'Smoke', category: 'Release', author: 'eva', done: true, created },
  ]

  it('turns the view state into the shared query', () => {
    const base = ProjectTodosFilter.initial()

    expect(ProjectTodosFilter.queryOf(base)).toEqual({})
    expect(ProjectTodosFilter.queryOf({ query: ' #ui ', category: { kind: 'none' }, author: 'eva', color: 'red', showDone: false }))
      .toEqual({ text: ' #ui ', category: '', author: 'eva', color: 'red', done: false })
    expect(ProjectTodosFilter.queryOf({ ...base, category: { kind: 'named', name: 'ui' } })).toEqual({ category: 'ui' })
  })

  it('shows what the query asks for, by category and by author', () => {
    const base = ProjectTodosFilter.initial()

    expect(ProjectTodosFilter.visible(items, { ...base, author: 'eva' }).map((item) => item.id)).toEqual(['o2', 'd1'])
    expect(ProjectTodosFilter.visible(items, { ...base, category: { kind: 'none' } }).map((item) => item.id)).toEqual(['o2'])
  })

  it('falls back to all when the category or the author is gone', () => {
    const stale = { ...ProjectTodosFilter.initial(), category: { kind: 'named' as const, name: 'gone' }, author: 'nobody' }

    expect(ProjectTodosFilter.settled(stale, items)).toMatchObject({ category: { kind: 'all' }, author: null })
    const kept = { ...ProjectTodosFilter.initial(), category: { kind: 'named' as const, name: 'UI' }, author: 'EVA' }
    expect(ProjectTodosFilter.settled(kept, items)).toBe(kept)
  })

  it('falls back to all colours when no task carries the colour, and gives a new task the colour in front', () => {
    const red = { ...ProjectTodosFilter.initial(), color: 'red' }

    expect(ProjectTodosFilter.settled(red, items).color).toBeNull()
    expect(ProjectTodosFilter.settled(red, [{ ...items[0], color: 'red' }])).toBe(red)
    expect(ProjectTodosFilter.colorForNew(red)).toBe('red')
    expect(ProjectTodosFilter.colorForNew({ ...red, color: '' })).toBe('')
  })

  it('gives one category one tone whatever its case', () => {
    expect(ProjectTodosFilter.toneOf('Release')).toBe(ProjectTodosFilter.toneOf('release'))
    expect(ProjectTodosFilter.tonesConst).toContain(ProjectTodosFilter.toneOf('anything'))
  })
})
