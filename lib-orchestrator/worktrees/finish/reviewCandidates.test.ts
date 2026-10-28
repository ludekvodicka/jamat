import { describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorktreeLease } from '../worktreeLease'
import { finishTestRecords, testAssembly } from './finishTestRecords'
import { ReviewCandidates } from './reviewCandidates'
import { SvnCommitMessageCheck } from '../../svn/svnCommitMessageCheck'

async function harness() {
  const h = await finishTestRecords({ step: 'reviewing', facts: { worker: { liveness: 'alive', resumeFailures: 0 }, syncedAt: { at: 1, revision: 5, headMovedBy: 4 } } })
  await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
    execution: { root: record.worktree!.worktreePath, requestedBy: 'window', startedAt: 1, checks: [], checkCursor: 0, rootCursor: 0, evidence: [] },
    preparation: { format: 1, manifest: 'fixture', content: testAssembly().content, metadata: testAssembly().metadata, commands: testAssembly().content, checks: 'none', checkedAt: 1, attempt: 0 } } }))
  let hash = 'before'
  const deps: ConstructorParameters<typeof ReviewCandidates>[0] = { records: h.records,
    commands: { lease: new WorktreeLease('review', () => []), verify: vi.fn(async () => {}), accept: vi.fn(async () => {}) },
    svn: { reviewRoots: async () => ({ ok: true, value: [] }), lowerBounds: async () => ({ ok: true, value: {} }), changes: async () => ({ ok: true, value: ['a', 'setup', 'a.mine'].map((path) => ({ path, kind: 'item', conflict: false })) }),
      commitHashes: async (_root, paths) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, path === 'a' ? hash : 'setup-hash'])) }) } }
  await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, setupBaseline: { at: 1, hashes: { setup: 'setup-hash' } } } }))
  const owner = async (name: string) => {
    const repositoryRoot = join(h.root, name)
    await mkdir(repositoryRoot, { recursive: true })
    await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, repositoryRoot } }))
    return repositoryRoot
  }
  return { ...h, step: new ReviewCandidates(deps), deps, owner, edit: () => { hash = 'after' } }
}

describe('ReviewCandidates', () => {
  it('takes the prefix from the repository owner and discards messages when a mount changes repositories', async () => {
    const h = await harness(), root = h.records.get('worker')!.worktree!.worktreePath
    h.deps.svn.changes = async () => ({ ok: true, value: [{ path: 'a', kind: 'item', conflict: false }] })
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: [{ path: root, own: '', pinned: false, changed: [] }] })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'file:///shared_electron', base: '/trunk', rootBase: 1, since: 1 } } })
    const first = await h.step.create('worker', '[shared_electron] Change updater', 'person-local')
    expect(first.review.repositories?.[0].expectedPrefix).toBe('[shared_electron]')
    await writeFile(join(await h.owner('Mirabia'), '.appgroup'), '{"kind":"product"}')
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'file:///applications', base: '/Mirabia', rootBase: 1, since: 1 } } })
    const second = await h.step.create('worker', '[shared_electron] Change updater', 'person-local')
    expect(second.review.repositories?.[0]).toMatchObject({ expectedPrefix: '[applications]', message: '', source: 'unknown' })
  })
  it('names a project inside a larger repository by its folder and refuses another prefix (Finish 072)', async () => {
    const h = await harness(), root = h.records.get('worker')!.worktree!.worktreePath
    await h.owner('Jamat')
    h.deps.svn.changes = async () => ({ ok: true, value: [{ path: 'a', kind: 'item', conflict: false }] })
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: [{ path: root, own: '', pinned: false, changed: [] }] })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'file:///applications', base: '/ProductivityTools/Jamat', rootBase: 1, since: 1 } } })
    const { review } = await h.step.create('worker', '', 'unknown')
    expect(review.repositories?.[0]).toMatchObject({ repositoryName: 'applications', expectedPrefix: '[Jamat]' })
    const press = { ...review, reviewVersion: review.version }
    const wrong = review.repositories!.map((row) => ({ ...row, message: '[applications] Fix', source: 'agent-proposal' as const }))
    expect(await h.step.approve('worker', { ...press, repositories: wrong }))
      .toEqual({ ok: false, code: 'message-unchecked', detail: 'applications: message must start with [Jamat]' })
    expect(h.records.get('worker')!.worktreeLifecycle!.step).toBe('reviewing')
    const right = review.repositories!.map((row) => ({ ...row, message: '[Jamat] Fix the review prefix', source: 'agent-proposal' as const }))
    const approved = await h.step.approve('worker', { ...press, repositories: right })
    expect(approved.ok && approved.review.repositories?.[0].message).toBe('[Jamat] Fix the review prefix')
  })
  it('loads each external proposal and preserves a human message across repository refresh', async () => {
    const h = await harness(), root = h.records.get('worker')!.worktree!.worktreePath
    await h.owner('Jamat')
    h.deps.svn.changes = async () => ({ ok: true, value: ['a', 'shared/a'].map((path) => ({ path, kind: 'item', conflict: false })) })
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: [{ path: root, own: '', pinned: false, changed: [] }, { path: join(root, 'shared'), own: 'shared', pinned: false, changed: [] }] })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'file:///applications', base: '/ProductivityTools/Jamat', rootBase: 1, since: 1 }, shared: { repository: 'file:///shared_frontend', base: '/trunk', rootBase: 1, since: 1 } } })
    h.deps.proposalOf = (_session, scope) => scope === root ? '[Jamat] Fix application' : '[shared_frontend] Fix library'
    const first = await h.step.create('worker', '', 'unknown')
    expect(first.review.repositories?.map((row) => [row.expectedPrefix, row.message])).toEqual([
      ['[Jamat]', '[Jamat] Fix application'], ['[shared_frontend]', '[shared_frontend] Fix library'],
    ])
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, review: { ...record.worktreeLifecycle!.review!,
      repositories: first.review.repositories!.map((row) => ({ ...row, source: 'person-local', message: 'My exact wording' })) } } }))
    const second = await h.step.create('worker', '', 'unknown')
    expect(second.review.repositories?.map((row) => row.message)).toEqual(['My exact wording', 'My exact wording'])
    const accepted = await h.step.approve('worker', { ...second.review, reviewVersion: second.review.version })
    expect(accepted.ok && accepted.review.repositories?.map((row) => row.message)).toEqual(['My exact wording', 'My exact wording'])
  })
  it('checks an agent repository message as proposed, before its prefix is added (UA1-J12-2)', async () => {
    const h = await harness(), root = h.records.get('worker')!.worktree!.worktreePath
    h.deps.svn.changes = async () => ({ ok: true, value: ['a', 'lib/ea/v'].map((path) => ({ path, kind: 'item', conflict: false })) })
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: [{ path: root, own: '', pinned: false, changed: [] }, { path: join(root, 'lib/ea'), own: 'lib/ea', pinned: false, changed: [] }] })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'file:///app/j12', base: '/', rootBase: 1, since: 1 }, 'lib/ea': { repository: 'file:///ea/j12', base: '/', rootBase: 1, since: 1 } } })
    h.deps.proposalOf = (_session, scope) => scope === root ? 'Here is the commit message for the change:\n[j12] J12 W4 app: limit 50' : null
    const { review } = await h.step.create('worker', '', 'unknown')
    const repositories = review.repositories!.map((row) => row.root === root ? row : { ...row, message: '[j12] J12 W4 EA', source: 'person-local' as const })
    const press = { ...review, reviewVersion: review.version, repositories }
    expect(await h.step.approve('worker', press)).toMatchObject({ ok: false, code: 'message-unchecked', detail: 'j12: No [Project] prefix; Chat opening' })
    const acknowledged = repositories.map((row) => ({ ...row, acknowledged: SvnCommitMessageCheck.findings(row.message, row.source) }))
    const approved = await h.step.approve('worker', { ...press, repositories: acknowledged })
    expect(approved.ok && approved.review.repositories?.find((row) => row.root === root)).toMatchObject({
      message: '[j12] Here is the commit message for the change:\n[j12] J12 W4 app: limit 50', source: 'agent-proposal', acknowledged: ['no-prefix', 'chat-opening'] })
  })
  it('excludes sidecars, includes setup in the tested set and binds the second window to its version', async () => {
    const h = await harness()
    const { rows, review } = await h.step.create('worker', '[Jamat] Fix', 'person-local')
    expect(rows).toEqual([{ path: 'a', origin: 'worker', checked: true }, { path: 'setup', origin: 'setup', checked: true }])
    expect(review.headMovedBy).toBe(4)
    const press = { ...review, reviewVersion: review.version }
    expect(await h.step.approve('worker', press)).toMatchObject({ ok: true })
    expect(await h.step.approve('worker', press)).toMatchObject({ ok: false, code: 'review-stale' })
    expect(h.deps.commands.verify).toHaveBeenCalledTimes(2)
  })

  it('refreshes changed selected evidence without accepting the old approval', async () => {
    const h = await harness()
    const { review } = await h.step.create('worker', '[Jamat] Fix', 'person-local')
    h.edit()
    expect(await h.step.approve('worker', { ...review, reviewVersion: review.version })).toMatchObject({ ok: false, changed: ['a'] })
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'reviewing', review: { hashes: { a: 'after' } } })
  })

  it('requires every reviewed path, including unversioned parents, before approval', async () => {
    const h = await harness()
    const { review } = await h.step.create('worker', '[Jamat] Fix', 'person-local')
    expect(await h.step.approve('worker', { ...review, selection: ['a'], reviewVersion: review.version }))
      .toMatchObject({ ok: false, changed: ['setup'], detail: expect.stringContaining('whole tested change set') })
    expect(h.records.get('worker')!.worktreeLifecycle!.approvedAt).toBeUndefined()
  })

  it.each(['new-dir/file.ts', 'new-dir/nested/file.ts', '.'])('validates the owning repository message for selected %s', async (selected) => {
    const h = await harness()
    const root = h.records.get('worker')!.worktree!.worktreePath
    const paths = [selected, 'shared/new-dir']
    h.deps.svn.changes = async () => ({ ok: true, value: paths.map((path) => ({ path, kind: 'item', conflict: false })) })
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: [
      { path: root, own: '', pinned: false, changed: [] },
      { path: join(root, 'shared'), own: 'shared', pinned: false, changed: [] },
    ] })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: {
      '': { repository: 'file:///applications', base: '/trunk', rootBase: 1, since: 1 },
      shared: { repository: 'file:///external', base: '/trunk', rootBase: 1, since: 1 },
    } })
    const { review } = await h.step.create('worker', '[applications] ', 'person-local')
    const press = { ...review, reviewVersion: review.version, selection: paths }
    expect(await h.step.approve('worker', press)).toMatchObject({ ok: false, code: 'message-unchecked', detail: expect.stringContaining('applications: Enter a commit message') })
    expect(h.records.get('worker')!.worktreeLifecycle!.step).toBe('reviewing')

    const repositories = review.repositories!.map((repository) => ({ ...repository,
      source: 'agent-proposal' as const,
      message: repository.repositoryName === 'applications' ? '[wrong] Change' : '[external] Add files',
    }))
    expect(await h.step.approve('worker', { ...press, repositories })).toMatchObject({ ok: false, code: 'message-unchecked', detail: expect.stringContaining('message must start with [applications]') })
    repositories[0]!.message = '[applications] Add selected file'
    expect(await h.step.approve('worker', { ...press, repositories })).toMatchObject({ ok: true })
  })
})
