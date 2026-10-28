import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TodoFiles } from './todoFiles'
import { context } from './reviewTodosTestFixtures'

let root: string
const ctx = context()
beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'review-todos-'))
  await mkdir(join(root, '.aidocs/review-todos'), { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const project = () => ({ categoryId: 'code', categoryPath: tmpdir(), projectPath: root })
async function file(name: string, status?: string, priority = 'p1') {
  await writeFile(join(TodoFiles.directory(project()), name), `---\n${status === undefined ? '' : `status: ${status}\n`}priority: ${priority}\n---\n# Scratch\n`)
}
async function read(mode: 'wt' | 'wc' = 'wc') { return TodoFiles.read(project(), (await TodoFiles.discover(project()))!, ctx, mode) }

it('filters complete and wont_fix after discovery and orders by priority', async () => {
  await file('901-ready-p2-b.md', 'ready', 'p2')
  await file('900-pending-p0-a.md', 'pending', 'p0')
  await file('902-complete-p1-c.md', 'complete')
  await file('903-wont_fix-p3-d.md', 'wont_fix', 'p3')
  await file('notes.md', 'pending')
  const items = await read()
  expect(items.map((item) => item.payload.fileName)).toEqual(['900-pending-p0-a.md', '901-ready-p2-b.md'])
  expect(items[0].payload).toEqual({ fileName: '900-pending-p0-a.md', categoryId: 'code', projectPath: root, priority: 'p0' })
  expect(ctx.log).toHaveBeenCalledTimes(1)
})

it.each([
  ['904-pending-p1-x.md', 'fixed', 'p1', 'status drift: file pending, frontmatter complete'],
  ['905-complete-p1-x.md', 'pending', 'p1', 'status drift: file complete, frontmatter pending'],
  ['906-pending-p1-x.md', 'pending', 'p2', 'priority drift: file p1, frontmatter p2'],
  ['907-pending-p1-x.md', undefined, 'p1', 'status missing'],
  ['909-pending-p1-x.md', '', 'p1', 'status missing'],
  ['908-pending-p1-x.md', 'maybe', 'p1', 'unknown status maybe'],
])('holds %s without changing its source', async (name, status, priority, hold) => {
  await file(name, status, priority)
  expect((await read())[0].hold).toBe(hold)
  expect(await TodoFiles.discover(project())).toEqual([name])
})

it.each(['pending', 'complete'])('detects duplicate ids before the %s status filter', async (status) => {
  await file('900-pending-p1-a.md', 'pending')
  await file(`900-${status}-p1-b.md`, status)
  const items = await read()
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ title: 'Duplicate id 900', selectable: false })
  expect(items[0].hold).toContain(`900-${status}-p1-b.md`)
})

it('lists from files alone and holds WT only for Git versioning mode', async () => {
  await file('900-pending-p1-x.md', 'pending')
  expect((await read('wt'))[0].hold).toBeUndefined()
  expect((await read('wc'))[0].hold).toBeUndefined()
  vi.mocked(ctx.sessions.versioningMode).mockReturnValue('git')
  expect((await read('wt'))[0].hold).toBe('Versioning mode Git makes Git worktrees: use WC or switch Settings → Versioning to checkpoints')
  expect((await read('wc'))[0].hold).toBeUndefined()
  vi.mocked(ctx.sessions.versioningMode).mockReturnValue('checkpoints')
  expect(ctx.svn.urlOf).not.toHaveBeenCalled()
  expect(ctx.svn.listAtHead).not.toHaveBeenCalled()
  expect(ctx.svn.changedNames).not.toHaveBeenCalled()
  expect(await TodoFiles.discover({ ...project(), projectPath: join(root, 'absent') })).toBeNull()
})

it('starts a WT todo only when committed at HEAD and unchanged, and a WC todo in any working copy', async () => {
  const name = '900-pending-p1-x.md'
  expect(await TodoFiles.launchHold(ctx, root, name, 'wt')).toBe('not committed')
  vi.mocked(ctx.svn.listAtHead).mockResolvedValue({ ok: true, value: [name] })
  vi.mocked(ctx.svn.changedNames).mockResolvedValue({ ok: true, value: [name] })
  expect(await TodoFiles.launchHold(ctx, root, name, 'wt')).toBe('local changes not committed')
  expect(ctx.svn.listAtHead).toHaveBeenLastCalledWith('https://svn/project/.aidocs/review-todos')
  expect(ctx.svn.changedNames).toHaveBeenLastCalledWith(TodoFiles.directory(project()))
  vi.mocked(ctx.svn.changedNames).mockResolvedValue({ ok: true, value: [] })
  expect(await TodoFiles.launchHold(ctx, root, name, 'wt')).toBeNull()
  vi.mocked(ctx.svn.listAtHead).mockClear()
  vi.mocked(ctx.svn.changedNames).mockResolvedValue({ ok: true, value: [name] })
  expect(await TodoFiles.launchHold(ctx, root, name, 'wc')).toBeNull()
  expect(ctx.svn.listAtHead).not.toHaveBeenCalled()
})

it('refuses a todo outside a working copy and passes on what svn says', async () => {
  vi.mocked(ctx.svn.urlOf).mockResolvedValueOnce({ ok: false, code: 'not-a-working-copy', detail: 'outside' })
  expect(await TodoFiles.launchHold(ctx, root, '900-pending-p1-x.md', 'wc')).toBe('no SVN working copy')
  vi.mocked(ctx.svn.listAtHead).mockResolvedValueOnce({ ok: false, code: 'svn-failed', detail: 'E200009 no such path' })
  expect(await TodoFiles.launchHold(ctx, root, '900-pending-p1-x.md', 'wt')).toBe('E200009 no such path')
})

it('explains a published terminal filename while the main copy still has its pending predecessor', async () => {
  vi.mocked(ctx.svn.listAtHead).mockResolvedValue({ ok: true, value: ['900-complete-p1-x.md'] })
  expect(await TodoFiles.launchHold(ctx, root, '900-pending-p1-x.md', 'wt')).toBe('Published in SVN; update the main copy to receive the completed task')
  vi.mocked(ctx.svn.listAtHead).mockResolvedValue({ ok: true, value: ['900-complete-p1-x.md', '900-ready-p1-x.md'] })
  expect(await TodoFiles.launchHold(ctx, root, '900-pending-p1-x.md', 'wt')).toBe('not committed')
})

it('orders ids numerically when the sequence passes 999', async () => {
  await file('1000-pending-p1-x.md', 'pending')
  await file('999-pending-p1-x.md', 'pending')
  expect((await read()).map((item) => item.payload.fileName)).toEqual(['999-pending-p1-x.md', '1000-pending-p1-x.md'])
})
