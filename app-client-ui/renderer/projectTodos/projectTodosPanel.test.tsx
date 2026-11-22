import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectTodos, type ProjectTodoItem, type ProjectTodoOperation } from '../../shared/projectTodos'
import { ProjectTodosPanel } from './projectTodosPanel'
import type { ProjectTodosPorts } from './projectTodosPorts'

describe('app-client-ui/renderer/projectTodos/projectTodosPanel', () => {
  const created = '2026-11-21T10:00:00.000Z'
  const projectConst = 'Q:/Apps/Alpha'
  let stored: readonly ProjectTodoItem[]
  let applied: ProjectTodoOperation[]
  let changed: ((project: string) => void) | null
  let refuseWith: 'file-conflict' | null

  /** An orchestrator in memory: the same rules, one list, and the change event. */
  function portsOf(change: Partial<ProjectTodosPorts> = {}): ProjectTodosPorts {
    const snapshot = () => ProjectTodos.snapshotOf(projectConst, `${projectConst}/.aidocs/todolist.jsonl`, 'dana', stored)
    return {
      list: () => Promise.resolve({ ok: true, value: { ok: true, value: snapshot() } }),
      apply: (_sessionId, operation) => {
        applied.push(operation)
        if (refuseWith !== null) return Promise.resolve({ ok: true, value: { ok: false, code: refuseWith, detail: `Refused: ${refuseWith}` } })
        const step = ProjectTodos.applied(stored, operation, { now: new Date().toISOString(), author: 'dana' })
        if (!step.ok) return Promise.resolve({ ok: true, value: { ok: false, code: 'invalid-operation', detail: step.detail } })
        stored = step.items
        return Promise.resolve({ ok: true, value: { ok: true, value: snapshot() } })
      },
      subscribe: (callback) => { changed = callback; return () => { changed = null } },
      ...change,
    }
  }

  beforeEach(() => {
    stored = [
      { id: 'a1', title: 'Host restart', category: 'bug', author: 'dana', done: false, created: '2026-11-21T10:03:00.000Z' },
      { id: 'b2', title: 'Sidebar tab', comment: 'narrow', category: 'ui', author: 'eva', done: false, created: '2026-11-21T10:02:00.000Z' },
      { id: 'c3', title: 'Smoke', done: true, created, doneAt: created },
    ]
    applied = []
    changed = null
    refuseWith = null
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  async function draw(variant: 'pane' | 'sidebar', ports = portsOf(), onOpenInSplit?: () => void) {
    const view = render(<ProjectTodosPanel sessionId="s1" ports={ports} variant={variant} onOpenInSplit={onOpenInSplit} />)
    await act(async () => {})
    return view
  }

  function titles(): string[] {
    return [...document.querySelectorAll('.project-todos__title')].map((button) => button.textContent ?? '')
  }

  it('lists open tasks first and filters by a category chip in the pane', async () => {
    await draw('pane')

    expect(titles()).toEqual(['Host restart', 'Sidebar tab', 'Smoke'])
    fireEvent.click(screen.getByRole('button', { name: /^ui/ }))
    expect(titles()).toEqual(['Sidebar tab'])
  })

  it('adds a task with the category of the filter in front and shows it on top', async () => {
    await draw('pane')
    fireEvent.click(screen.getByRole('button', { name: /^bug/ }))
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Second bug' } })
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('New task'), { key: 'Enter' }) })

    expect(applied).toMatchObject([{ kind: 'add', title: 'Second bug', category: 'bug', comment: '' }])
    expect(titles()).toEqual(['Second bug', 'Host restart'])
  })

  it('adds a task on Enter in the category field of the pane', async () => {
    await draw('pane')
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Release notes' } })
    fireEvent.change(screen.getByLabelText('Category of the new task'), { target: { value: 'release' } })
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('Category of the new task'), { key: 'Enter' }) })

    expect(applied).toMatchObject([{ kind: 'add', title: 'Release notes', category: 'release' }])
    expect(screen.getByLabelText('New task')).toHaveValue('')
  })

  it('adds a task on Enter in the sidebar', async () => {
    await draw('sidebar')
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Narrow one' } })
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('New task'), { key: 'Enter' }) })

    expect(applied).toMatchObject([{ kind: 'add', title: 'Narrow one' }])
  })

  it('offers a comment for the new task once the form has focus, adds on Ctrl+Enter, and hides it again when empty', async () => {
    await draw('pane')
    expect(screen.queryByLabelText('Comment of the new task')).toBeNull()
    fireEvent.focus(screen.getByLabelText('New task'))
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'With notes' } })
    const comment = screen.getByLabelText('Comment of the new task')
    fireEvent.change(comment, { target: { value: 'first\nsecond' } })
    fireEvent.keyDown(comment, { key: 'Enter' })
    expect(applied).toEqual([])

    await act(async () => { fireEvent.keyDown(comment, { key: 'Enter', ctrlKey: true }) })
    expect(applied).toMatchObject([{ kind: 'add', title: 'With notes', comment: 'first\nsecond' }])
    expect(screen.getByLabelText('Comment of the new task')).toHaveValue('')
    fireEvent.blur(screen.getByLabelText('Comment of the new task'), { relatedTarget: screen.getByLabelText('Search tasks') })
    expect(screen.queryByLabelText('Comment of the new task')).toBeNull()
  })

  it('keeps a typed comment of the new task when focus leaves the form', async () => {
    await draw('sidebar')
    fireEvent.focus(screen.getByLabelText('New task'))
    fireEvent.change(screen.getByLabelText('Comment of the new task'), { target: { value: 'kept' } })
    fireEvent.blur(screen.getByLabelText('Comment of the new task'), { relatedTarget: screen.getByLabelText('Search tasks') })
    expect(screen.getByLabelText('Comment of the new task')).toHaveValue('kept')
  })

  it('closes an open task to its row when focus leaves it, and keeps it open while focus moves inside', async () => {
    await draw('pane')
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar tab' }))
    fireEvent.blur(screen.getByLabelText('Title'), { relatedTarget: screen.getByLabelText('Comment') })
    expect(screen.getByLabelText('Title')).toBeInTheDocument()

    await act(async () => { fireEvent.blur(screen.getByLabelText('Comment'), { relatedTarget: screen.getByLabelText('Search tasks') }) })
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(titles()).toContain('Sidebar tab')
  })

  it('closes an open task with Escape and gives its row the caret, so the next Escape is the pane\'s', async () => {
    await draw('pane')
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar tab' }))
    expect(screen.getByLabelText('Title').closest('[data-own-escape="true"]')).not.toBeNull()

    await act(async () => { fireEvent.keyDown(screen.getByLabelText('Comment'), { key: 'Escape' }) })
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sidebar tab' }))
    expect(document.activeElement?.closest('[data-own-escape="true"]')).toBeNull()
  })

  it('keeps Escape for a search with text and for a typed new task, and focuses the new task through its ref', async () => {
    const titleField: { current: HTMLInputElement | null } = { current: null }
    render(<ProjectTodosPanel sessionId="s1" ports={portsOf()} variant="pane" ref={titleField} />)
    await act(async () => {})
    expect(titleField.current).toBe(screen.getByLabelText('New task'))

    expect(document.querySelector('.project-todos--pane')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByLabelText('Search tasks')).not.toHaveAttribute('data-own-escape')
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'host' } })
    expect(screen.getByLabelText('Search tasks')).toHaveAttribute('data-own-escape', 'true')
    expect(screen.getByLabelText('New task').closest('[data-own-escape="true"]')).toBeNull()
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'typed' } })
    expect(screen.getByLabelText('New task').closest('[data-own-escape="true"]')).not.toBeNull()
  })

  it('adds a task with the colour picked beside the category', async () => {
    await draw('pane')
    fireEvent.click(screen.getByRole('button', { name: 'Colour of the new task: No colour' }))
    fireEvent.click(screen.getByRole('option', { name: 'Teal' }))
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Tinted' } })
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('New task'), { key: 'Enter' }) })

    expect(applied).toMatchObject([{ kind: 'add', title: 'Tinted', color: 'teal' }])
    expect(stored.find((item) => item.title === 'Tinted')?.color).toBe('teal')
    const row = screen.getByRole('button', { name: 'Tinted' }).closest('li')!
    expect(within(row).getByRole('img', { name: 'Colour: Teal' })).toHaveClass('project-todos__tone--teal')
    expect(within(screen.getByRole('button', { name: 'Host restart' }).closest('li')!).queryByRole('img', { name: /^Colour/ })).toBeNull()
  })

  it('filters by colour and by no colour once a task has one', async () => {
    stored = stored.map((item) => item.id === 'b2' ? { ...item, color: 'red' as const } : item)
    await draw('sidebar')
    fireEvent.click(screen.getByRole('button', { name: 'Colour filter: All colours' }))
    expect(within(screen.getByRole('listbox', { name: 'Colour filter' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['All colours', 'Red1', 'No colour2'])
    fireEvent.click(screen.getByRole('option', { name: /^Red/ }))
    expect(titles()).toEqual(['Sidebar tab'])

    fireEvent.click(screen.getByRole('button', { name: 'Colour filter: Red' }))
    fireEvent.click(screen.getByRole('option', { name: /^No colour/ }))
    expect(titles()).toEqual(['Host restart', 'Smoke'])
  })

  it('changes the colour of an open task at once, and Escape closes only the colour list', async () => {
    await draw('pane')
    fireEvent.click(screen.getByRole('button', { name: 'Host restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Colour: No colour' }))
    fireEvent.keyDown(screen.getByRole('option', { name: 'Red' }), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByLabelText('Title')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Colour: No colour' }))
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Violet' })) })
    expect(applied).toMatchObject([{ kind: 'edit', id: 'a1', color: 'violet' }])
    expect(stored.find((item) => item.id === 'a1')?.color).toBe('violet')
  })

  it('toggles a task done', async () => {
    await draw('sidebar')
    await act(async () => { fireEvent.click(screen.getByLabelText('Done: Host restart')) })

    expect(applied).toEqual([{ kind: 'toggle', id: 'a1', done: true }])
    expect(stored[0]).toMatchObject({ id: 'a1', done: true })
  })

  it('edits an open task and sends one change after typing stops', async () => {
    vi.useFakeTimers()
    await draw('pane')
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar tab' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'narrow\nsecond line' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'ui ' } })

    expect(screen.getByLabelText<HTMLInputElement>('Category').value).toBe('ui ')
    expect(applied).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(applied).toEqual([{ kind: 'edit', id: 'b2', title: 'Sidebar tab', category: 'ui ', comment: 'narrow\nsecond line', color: '' }])
    expect(stored[1]).toMatchObject({ category: 'ui', comment: 'narrow\nsecond line' })
  })

  it('deletes a task and puts it back at its place with Undo', async () => {
    await draw('pane')
    fireEvent.click(screen.getByRole('button', { name: 'Host restart' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(titles()).toEqual(['Sidebar tab', 'Smoke'])

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    expect(titles()).toEqual(['Host restart', 'Sidebar tab', 'Smoke'])
    expect(applied.map((operation) => operation.kind)).toEqual(['remove', 'restore'])
  })

  it('reads the list again when it moved elsewhere', async () => {
    await draw('sidebar')
    stored = [{ id: 'z9', title: 'Written by an agent', done: false, created }]
    await act(async () => { changed?.(projectConst) })

    expect(titles()).toEqual(['Written by an agent'])
  })

  it('says why a session outside the catalog has no list', async () => {
    await draw('sidebar', portsOf({ list: () => Promise.resolve({ ok: true, value: { ok: false, code: 'no-project', detail: 'Not in a catalog project.' } }) }))

    expect(screen.getByText('Not in a catalog project.')).toBeTruthy()
    expect(screen.queryByLabelText('New task')).toBeNull()
  })

  it('filters by author when more than one person wrote into the list', async () => {
    await draw('pane')
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: 'eva' } })

    expect(titles()).toEqual(['Sidebar tab'])
    expect(screen.getByRole('option', { name: 'dana (me)' })).toBeTruthy()
  })

  it('keeps a change the conflicted file refused, says why, and sends it once the file moved', async () => {
    await draw('sidebar')
    refuseWith = 'file-conflict'
    await act(async () => { fireEvent.click(screen.getByLabelText('Done: Host restart')) })

    expect(screen.getByRole('alert').textContent).toContain('Refused: file-conflict')
    expect(screen.getByLabelText<HTMLInputElement>('Done: Host restart').checked).toBe(true)
    refuseWith = null
    await act(async () => { changed?.(projectConst) })
    expect(stored.find((item) => item.id === 'a1')).toMatchObject({ done: true })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a conflicted file without breaking and reads it again once it moved', async () => {
    let conflicted = true
    const ports = portsOf({ list: () => Promise.resolve(conflicted
      ? { ok: true, value: { ok: false, code: 'file-conflict', detail: 'The file has an unresolved SVN conflict.' } }
      : { ok: true, value: { ok: true, value: ProjectTodos.snapshotOf(projectConst, 'f', 'dana', stored) } }) })
    await draw('pane', ports)

    expect(screen.getByText(/unresolved SVN conflict/)).toBeTruthy()
    conflicted = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    expect(titles()).toEqual(['Host restart', 'Sidebar tab', 'Smoke'])
  })

  it('offers the split from the sidebar', async () => {
    const open = vi.fn()
    await draw('sidebar', portsOf(), open)
    fireEvent.click(screen.getByRole('button', { name: 'Open in the split' }))

    expect(open).toHaveBeenCalledOnce()
  })
})
