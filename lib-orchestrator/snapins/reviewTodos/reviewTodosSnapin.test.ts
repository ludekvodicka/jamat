import { expect, it, vi } from 'vitest'
import type { SnapinItem } from '../shared/snapinContract'
import { ReviewTodosSnapin } from './reviewTodosSnapin'
import { context } from './reviewTodosTestFixtures'

const snapin = new ReviewTodosSnapin()
function item(project: string, id: string, priority: string): SnapinItem {
  return { key: `review-todos:${project}:${id}`, title: 'Scratch', projectDirectory: project, group: project, mode: 'wt',
    selectable: true, actions: [], payload: { fileName: `${id}-pending-${priority}-scratch.md`, priority, categoryId: 'code', projectPath: project } }
}
it('creates the project binding, attempt slug and single-todo brief', async () => {
  const ctx = context()
  vi.mocked(ctx.svn.listAtHead).mockResolvedValue({ ok: true, value: ['900-pending-p1-scratch.md'] })
  expect(await snapin.launchSpec(ctx, {}, item('project', '900', 'p1'), '1234abcd-rest')).toEqual({
    directory: { mode: 'project', categoryId: 'code', projectPath: 'project' }, worktreeSlug: '1234abcd',
    title: 'Todo 900: scratch', number: 'r900', work: { kind: 'todo', todoId: '900', relativePath: '.aidocs/review-todos/900-pending-p1-scratch.md' },
  })
  expect(ctx.svn.urlOf).toHaveBeenCalledWith('project')
})
it('checks svn only for the todo being started and refuses it with the reason', async () => {
  const ctx = context()
  expect(await snapin.launchSpec(ctx, {}, item('project', '900', 'p1'), '1234abcd-rest')).toEqual({ hold: 'not committed' })
  expect(await snapin.launchSpec(ctx, {}, { ...item('project', '901', 'p1'), hold: 'status missing' }, '1234abcd-rest'))
    .toEqual({ hold: 'status missing' })
  expect(ctx.svn.urlOf).toHaveBeenCalledOnce()
})
it('orders payload priorities first, alternating projects inside each priority', () => {
  const items = [item('a', '901', 'p1'), item('b', '901', 'p1'), item('a', '902', 'p0'), item('a', '900', 'p0'), item('b', '900', 'p0')]
  expect(snapin.solveAllOrder(items).map((row) => row.key)).toEqual(['review-todos:a:900', 'review-todos:b:900', 'review-todos:a:902', 'review-todos:a:901', 'review-todos:b:901'])
})
it('returns catalog failures and validates project modes', async () => {
  const ctx = context()
  vi.mocked(ctx.projects.projects).mockRejectedValueOnce(new Error('catalog offline'))
  expect(await snapin.list(ctx, {})).toEqual({ ok: false, detail: 'catalog offline' })
  expect(snapin.settings.validate({ modes: { project: 'wc' } })).toBeNull()
  expect(snapin.settings.validate({ modes: { project: 'bad' } })).toContain('wt or wc')
})

it('keeps numeric id ordering inside a project when the sequence passes 999', () => {
  expect(snapin.solveAllOrder([item('a', '1000', 'p1'), item('a', '999', 'p1')]).map((row) => row.key))
    .toEqual(['review-todos:a:999', 'review-todos:a:1000'])
})
