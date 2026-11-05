import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { VersioningReviewStore, type VersioningReviewRecord } from './versioningReviewStore'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jamat-review-store-'))
  roots.push(root)
  const file = join(root, 'reviews.json')
  return { file, report: vi.fn() }
}
const review: VersioningReviewRecord = {
  cwd: 'C:/repo', lockRoot: 'c:/repo', dto: { draftId: 'review', epoch: 'ephemeral', sessionId: 'session', vcs: 'svn',
    source: 'svn', scopeRoot: 'C:/repo', scopeTooltip: 'C:/repo', message: '', editedByPerson: true, proposedByAgent: false,
    phase: { kind: 'editing' }, revision: 4, selection: { paths: ['C:/repo/a'], snapshotId: 'source-snapshot' } },
}

it('atomically retains semantic edits and excludes the process epoch', async () => {
  const f = await fixture()
  expect(new VersioningReviewStore(f.file, f.report).save([review])).toBe(true)
  const restored = new VersioningReviewStore(f.file, f.report).read()
  expect(restored).toMatchObject([{ dto: { message: '', editedByPerson: true, selection: review.dto.selection } }])
  expect(restored[0].dto.epoch).toBeUndefined()
  expect(await readFile(f.file, 'utf8')).not.toContain('ephemeral')
})

it('preserves a damaged document and refuses writes instead of replacing it', async () => {
  const f = await fixture()
  await writeFile(f.file, '{damaged')
  const store = new VersioningReviewStore(f.file, f.report)
  expect(store.read()).toEqual([])
  expect(store.save([review])).toBe(false)
  expect(await readFile(f.file, 'utf8')).toBe('{damaged')
  expect(f.report).toHaveBeenCalled()
})
