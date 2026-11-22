import { describe, expect, it } from 'vitest'

import type { ProjectTodoItem } from '../../shared/projectTodos'
import { ProjectTodosQueue } from './projectTodosQueue'

describe('app-client-ui/renderer/projectTodos/projectTodosQueue', () => {
  const now = '2026-11-21T10:00:00.000Z'
  const first: ProjectTodoItem = { id: 'a1', title: 'First', done: false, created: now }

  it('shows the waiting changes over the confirmed list at once', () => {
    const state = ProjectTodosQueue.enqueued(ProjectTodosQueue.of([first]), { kind: 'toggle', id: 'a1', done: true })

    expect(ProjectTodosQueue.shown(state, { now, author: 'dana' })).toEqual([{ ...first, done: true, doneAt: now }])
    expect(state.confirmed).toEqual([first])
  })

  it('folds typing into the unsent edit or add of the same task', () => {
    let state = ProjectTodosQueue.enqueued(ProjectTodosQueue.of([]), { kind: 'add', id: 'n1', title: 'N', category: '', comment: '' })
    state = ProjectTodosQueue.enqueued(state, { kind: 'edit', id: 'n1', title: 'New', category: 'ui', comment: 'c' })

    expect(state.queue).toEqual([{ kind: 'add', id: 'n1', title: 'New', category: 'ui', comment: 'c' }])
  })

  it('never folds into the change in flight', () => {
    const queued = ProjectTodosQueue.enqueued(ProjectTodosQueue.of([first]), { kind: 'edit', id: 'a1', title: 'One', category: '', comment: '' })
    const out = ProjectTodosQueue.sent(queued)
    if (out === null) throw new Error('nothing went out')
    const state = ProjectTodosQueue.enqueued(out.state, { kind: 'edit', id: 'a1', title: 'Two', category: '', comment: '' })

    expect(state.queue).toHaveLength(2)
    expect(ProjectTodosQueue.sent(state)).toBeNull()
  })

  it('adopts the stored list, drops a refused change, keeps a lost one', () => {
    const queued = ProjectTodosQueue.enqueued(ProjectTodosQueue.of([]), { kind: 'remove', id: 'a1' })
    const out = ProjectTodosQueue.sent(queued)!.state

    expect(ProjectTodosQueue.stored(out, [first])).toEqual({ confirmed: [first], queue: [], sending: false })
    expect(ProjectTodosQueue.refused(out)).toEqual({ confirmed: [], queue: [], sending: false })
    expect(ProjectTodosQueue.failed(out)).toEqual({ ...out, sending: false })
  })

  it('adopts a fresh reading only while nothing waits', () => {
    const waiting = ProjectTodosQueue.enqueued(ProjectTodosQueue.of([]), { kind: 'remove', id: 'a1' })

    expect(ProjectTodosQueue.read(waiting, [first])).toBe(waiting)
    expect(ProjectTodosQueue.read(ProjectTodosQueue.of([]), [first]).confirmed).toEqual([first])
  })
})
