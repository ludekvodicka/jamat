import { describe, expect, it } from 'vitest'

import { ProjectTodos, type ProjectTodoItem, type ProjectTodosStep } from './projectTodos'

describe('lib-orchestrator/clientApi/projectTodos', () => {
  const now = '2026-11-21T10:00:00.000Z'
  const later = '2026-11-21T11:00:00.000Z'
  const stamp = { now: later, author: 'dana' }
  const open: ProjectTodoItem = { id: 'a1', title: 'First', category: 'ui', author: 'dana', done: false, created: now }
  const done: ProjectTodoItem = { id: 'b2', title: 'Second', comment: 'two\nlines', done: true, created: now, doneAt: later }
  const header = '{"format":"jamat-todolist","version":1}'

  function itemsOf(step: ProjectTodosStep): readonly ProjectTodoItem[] {
    if (!step.ok) throw new Error(step.detail)
    return step.items
  }

  describe('serialize and parse', () => {
    it('writes the header, one task per line sorted by id, a blank line between tasks', () => {
      const text = ProjectTodos.serialize([done, open])

      expect(text).toBe(`${header}\n\n${JSON.stringify(open)}\n\n${JSON.stringify(done)}\n`)
      expect(ProjectTodos.parse(text)).toEqual({ ok: true, items: [open, done] })
    })

    it('writes keys in a fixed order whatever order they came in', () => {
      const shuffled = { created: now, done: false, author: 'dana', category: 'ui', title: 'First', id: 'a1' } as ProjectTodoItem

      expect(ProjectTodos.serialize([shuffled]).split('\n')[2])
        .toBe('{"id":"a1","title":"First","category":"ui","author":"dana","done":false,"created":"2026-11-21T10:00:00.000Z"}')
    })

    it('writes the colour after the category and drops a colour this build does not know', () => {
      const colored: ProjectTodoItem = { ...open, color: 'teal' }

      expect(ProjectTodos.serialize([colored]).split('\n')[2])
        .toBe('{"id":"a1","title":"First","category":"ui","color":"teal","author":"dana","done":false,"created":"2026-11-21T10:00:00.000Z"}')
      expect(ProjectTodos.parse(`${header}\n{"id":"a1","title":"First","color":"chartreuse","done":false,"created":"${now}"}\n`))
        .toEqual({ ok: true, items: [{ id: 'a1', title: 'First', done: false, created: now }] })
    })

    it('reads CRLF, extra blank lines, an empty text and drops empty fields and the doneAt of an open task', () => {
      const text = `${header}\r\n\r\n\r\n{"id":"a1","title":"First","category":" ui ","author":"dana","comment":"","done":false,"created":"${now}","doneAt":"${later}","extra":1}\r\n`

      expect(ProjectTodos.parse(text)).toEqual({ ok: true, items: [open] })
      expect(ProjectTodos.parse('\n\n')).toEqual({ ok: true, items: [] })
    })

    it('names an unresolved version control conflict apart from other damage', () => {
      const conflicted = `${header}\n\n<<<<<<< .mine\n${JSON.stringify(open)}\n=======\n${JSON.stringify({ ...open, title: 'Theirs' })}\n>>>>>>> .r12\n`

      expect(ProjectTodos.parse(conflicted)).toMatchObject({ ok: false, conflict: true })
    })

    it('refuses what is not a readable list instead of reading it as empty', () => {
      for (const text of ['not json', '{"version":1}', '{"format":"jamat-todolist","version":2}',
        `${header}\n{"id":"a","title":"x"}`, `${header}\n${JSON.stringify(open)}\n${JSON.stringify(open)}`])
        expect(ProjectTodos.parse(text)).toMatchObject({ ok: false, conflict: false })
    })
  })

  describe('a merge of two edited copies', () => {
    /** The line-based three-way rule: a change on each side merges when an unchanged line separates them. */
    it('changes only the line of the changed task', () => {
      const base = ProjectTodos.serialize([open, done]).split('\n')
      const toggled = ProjectTodos.serialize(itemsOf(ProjectTodos.applied([open, done], { kind: 'toggle', id: 'a1', done: true }, stamp))).split('\n')
      const edited = ProjectTodos.serialize(itemsOf(ProjectTodos.applied([open, done], { kind: 'edit', id: 'b2', title: 'Renamed' }, stamp))).split('\n')

      const changedLines = (copy: string[]): number[] => copy.flatMap((line, index) => line === base[index] ? [] : [index])
      expect(changedLines(toggled)).toEqual([2])
      expect(changedLines(edited)).toEqual([4])
      expect(base[3]).toBe('')
    })
  })

  describe('applied', () => {
    it('adds a task with its author and a trimmed category', () => {
      const items = itemsOf(ProjectTodos.applied([open], { kind: 'add', id: 'c3', title: 'New', category: ' bug ' }, stamp))

      expect(items).toEqual([open, { id: 'c3', title: 'New', category: 'bug', author: 'dana', done: false, created: later }])
    })

    it('refuses an add without a title, without an id or with a used id', () => {
      expect(ProjectTodos.applied([], { kind: 'add', id: 'c3', title: '  ' }, stamp).ok).toBe(false)
      expect(ProjectTodos.applied([], { kind: 'add', title: 'x' }, stamp).ok).toBe(false)
      expect(ProjectTodos.applied([open], { kind: 'add', id: 'a1', title: 'x' }, stamp).ok).toBe(false)
    })

    it('edits only the texts it names and removes a cleared category', () => {
      expect(itemsOf(ProjectTodos.applied([open], { kind: 'edit', id: 'a1', comment: 'note' }, stamp)))
        .toEqual([{ ...open, comment: 'note' }])
      const { category: _category, ...withoutCategory } = open
      expect(itemsOf(ProjectTodos.applied([open], { kind: 'edit', id: 'a1', category: '' }, stamp))).toEqual([withoutCategory])
    })

    it('adds, changes and clears a colour, and refuses one outside the palette', () => {
      const added = itemsOf(ProjectTodos.applied([], { kind: 'add', id: 'c3', title: 'New', color: 'red' }, stamp))
      expect(added[0].color).toBe('red')
      expect(itemsOf(ProjectTodos.applied(added, { kind: 'edit', id: 'c3', color: 'blue' }, stamp))[0].color).toBe('blue')
      expect(itemsOf(ProjectTodos.applied(added, { kind: 'edit', id: 'c3', color: '' }, stamp))[0]).not.toHaveProperty('color')
      expect(itemsOf(ProjectTodos.applied(added, { kind: 'edit', id: 'c3', title: 'Renamed' }, stamp))[0].color).toBe('red')
      expect(ProjectTodos.operationProblemOf({ kind: 'edit', id: 'c3', color: 'pink' })).not.toBeNull()
      expect(ProjectTodos.operationProblemOf({ kind: 'add', title: 'x', color: 5 })).not.toBeNull()
    })

    it('stamps a completed task and clears the stamp when it opens again', () => {
      const closed = itemsOf(ProjectTodos.applied([open], { kind: 'toggle', id: 'a1', done: true }, stamp))
      expect(closed).toEqual([{ ...open, done: true, doneAt: later }])

      expect(itemsOf(ProjectTodos.applied(closed, { kind: 'toggle', id: 'a1', done: false }, stamp))).toEqual([open])
    })

    it('removes a task and restores it once', () => {
      const removed = itemsOf(ProjectTodos.applied([open, done], { kind: 'remove', id: 'a1' }, stamp))
      expect(removed).toEqual([done])

      const restored = itemsOf(ProjectTodos.applied(removed, { kind: 'restore', item: open }, stamp))
      expect(restored).toEqual([open, done])
      expect(itemsOf(ProjectTodos.applied(restored, { kind: 'restore', item: open }, stamp))).toEqual([open, done])
    })

    it('refuses a change of a task that no longer exists', () => {
      expect(ProjectTodos.applied([], { kind: 'edit', id: 'a1', title: 'x' }, stamp).ok).toBe(false)
      expect(ProjectTodos.applied([], { kind: 'toggle', id: 'a1', done: true }, stamp).ok).toBe(false)
      expect(ProjectTodos.applied([], { kind: 'remove', id: 'a1' }, stamp).ok).toBe(false)
    })

    it('holds the limits', () => {
      const long = 'x'.repeat(ProjectTodos.titleMaxConst + 1)
      expect(ProjectTodos.applied([open], { kind: 'edit', id: 'a1', title: long }, stamp).ok).toBe(false)
      expect(ProjectTodos.applied([open], { kind: 'edit', id: 'a1', title: 'two\nlines' }, stamp).ok).toBe(false)
      const full = Array.from({ length: ProjectTodos.itemsMaxConst }, (_, index) => ({ ...open, id: `t${index}` }))
      expect(ProjectTodos.applied(full, { kind: 'add', id: 'z', title: 'one more' }, stamp).ok).toBe(false)
    })
  })

  describe('operationProblemOf', () => {
    it('refuses what the wire may hand in', () => {
      for (const operation of [null, [], { kind: 'drop' }, { kind: 'remove', id: 'a b' }, { kind: 'toggle', id: 'a1' },
        { kind: 'edit', id: 'a1' }, { kind: 'edit', id: 'a1', title: 3 }, { kind: 'add', title: 'x', category: 1 },
        { kind: 'restore', item: { id: 'a1' } }])
        expect(ProjectTodos.operationProblemOf(operation)).not.toBeNull()
      expect(ProjectTodos.operationProblemOf({ kind: 'add', title: 'no id is fine on the wire' })).toBeNull()
    })
  })

  describe('visible', () => {
    const created = (minute: number): string => `2026-11-21T10:${String(minute).padStart(2, '0')}:00.000Z`
    const items: ProjectTodoItem[] = [
      { id: 'd1', title: 'Ověřit smoke', category: 'Release', author: 'eva', done: true, created: created(1) },
      { id: 'o1', title: 'Úloha pro sidebar', comment: 'šířka 280 px', category: 'ui', author: 'dana', done: false, created: created(2) },
      { id: 'o2', title: 'Host restart', category: 'bug', author: 'eva', done: false, created: created(3) },
      { id: 'o3', title: 'Loose end', done: false, created: created(4) },
    ]
    const idsOf = (shown: readonly ProjectTodoItem[]): string[] => shown.map((item) => item.id)

    it('puts open tasks first and done ones last, newest first in each', () => {
      expect(idsOf(ProjectTodos.visible(items))).toEqual(['o3', 'o2', 'o1', 'd1'])
    })

    it('searches title, comment and category without case or diacritics', () => {
      expect(idsOf(ProjectTodos.visible(items, { text: 'ULOHA sirka' }))).toEqual(['o1'])
    })

    it('reads #word as a category and @word as an author', () => {
      expect(idsOf(ProjectTodos.visible(items, { text: '#release' }))).toEqual(['d1'])
      expect(idsOf(ProjectTodos.visible(items, { text: '@EVA' }))).toEqual(['o2', 'd1'])
    })

    it('filters by category, by no category, by author and by done', () => {
      expect(idsOf(ProjectTodos.visible(items, { category: 'UI' }))).toEqual(['o1'])
      expect(idsOf(ProjectTodos.visible(items, { category: '' }))).toEqual(['o3'])
      expect(idsOf(ProjectTodos.visible(items, { author: 'eva', done: false }))).toEqual(['o2'])
      expect(idsOf(ProjectTodos.visible(items, { done: true }))).toEqual(['d1'])
    })

    it('filters by colour and by no colour, and counts colours in palette order', () => {
      const colored: ProjectTodoItem[] = [{ ...items[0], color: 'violet' }, { ...items[1], color: 'red' }, { ...items[2], color: 'violet' }, items[3]]

      expect(idsOf(ProjectTodos.visible(colored, { color: 'violet' }))).toEqual(['o2', 'd1'])
      expect(idsOf(ProjectTodos.visible(colored, { color: '' }))).toEqual(['o3'])
      expect(ProjectTodos.colorsOf(colored)).toEqual([{ name: 'red', count: 1 }, { name: 'violet', count: 2 }])
    })

    it('counts categories and authors sorted by name', () => {
      expect(ProjectTodos.categoriesOf(items)).toEqual([{ name: 'bug', count: 1 }, { name: 'Release', count: 1 }, { name: 'ui', count: 1 }])
      expect(ProjectTodos.authorsOf(items)).toEqual([{ name: 'dana', count: 1 }, { name: 'eva', count: 2 }])
    })
  })
})
