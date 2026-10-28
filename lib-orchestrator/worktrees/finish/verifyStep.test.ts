import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { finishTestRecords } from './finishTestRecords'
import { VerifyStep } from './verifyStep'
import type { WorktreeReviewSnapshot } from '../worktreeState'

describe('VerifyStep', () => {
  async function fixture() {
    const h = await finishTestRecords({ step: 'verifying' })
    const root = h.records.get('worker')!.worktree!.worktreePath
    await mkdir(root, { recursive: true })
    const bytes = Buffer.from('line one\r\nline two\r\n')
    await writeFile(join(root, 'a'), bytes)
    let hash = createHash('sha256').update(bytes).update('svn:eol-style=native').digest('hex')
    const review: WorktreeReviewSnapshot = { version: 1, selection: ['a', 'deleted'], hashes: { a: hash, deleted: 'missing' },
      deletions: ['deleted'], message: '[App] Fix', source: 'person-local', acknowledged: [], headMovedBy: 0 }
    const step = new VerifyStep(h.records, { advancePublished: async () => ({ ok: true, value: undefined }), commitHashes: async () => ({ ok: true, value: { a: hash } }),
      publicationHashes: async () => ({ ok: true, value: { a: review.hashes.a } }),
      publicationRows: async () => ({ ok: true, value: { items: [{ path: 'a', item: 'normal', props: 'normal', base: 487, changed: 487 }],
        changed: [{ path: 'a', revision: 487, action: 'R' }, { path: 'deleted', revision: 487, action: 'D' }] } }) })
    return { ...h, root, step, review, hashOf: () => hash, edit: () => { hash = 'post-commit-edit-or-property-change' } }
  }

  it('verifies native CRLF bytes, approved properties, replacement and delete at the publication revision', async () => {
    const h = await fixture()
    expect(await h.step.run('worker', h.root, 487, h.review, 'disposing')).toEqual({ verified: true, differences: [] })
    expect((await h.reload()).get('worker')?.worktreeLifecycle).toMatchObject({ step: 'disposing', verified: [{ revision: 487, paths: ['a', 'deleted'] }] })
  })

  it('keeps post-commit edits and newly recreated deletion content as differences', async () => {
    const h = await fixture()
    h.edit()
    await writeFile(join(h.root, 'deleted'), 'new user data')
    expect(await h.step.run('worker', h.root, 487, h.review, 'disposing')).toEqual({ verified: false, differences: ['a', 'deleted'] })
    expect(h.records.get('worker')?.worktreeLifecycle?.wait).toMatchObject({ kind: 'published-with-differences', reason: expect.stringContaining('r487') })
  })

  /** UA1-J09-2: the client that published r487 died before it gave its nodes that revision. */
  it('gives the published revision to nodes a killed commit left behind only when their bytes match', async () => {
    const h = await fixture()
    const advancePublished = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const step = new VerifyStep(h.records, { advancePublished, commitHashes: async () => ({ ok: true, value: { a: h.hashOf() } }),
      publicationHashes: async () => ({ ok: true, value: { a: h.review.hashes.a } }),
      publicationRows: async () => ({ ok: true, value: { items: [{ path: 'a', item: 'modified', props: 'normal', base: 486, changed: 486 },
        { path: 'deleted', item: 'deleted', props: 'none', base: 486, changed: 486 }],
        changed: [{ path: 'a', revision: 487, action: 'M' }, { path: 'deleted', revision: 487, action: 'D' }] } }) })
    await step.advance(h.root, 487, h.review)
    expect(advancePublished).toHaveBeenLastCalledWith(h.root, ['a', 'deleted'], 487)
    h.edit()
    await step.advance(h.root, 487, h.review)
    expect(advancePublished).toHaveBeenLastCalledWith(h.root, ['deleted'], 487)
    await h.step.advance(h.root, 487, h.review)
    expect(advancePublished).toHaveBeenCalledTimes(2)
  })
})
