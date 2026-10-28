import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeLifecycle } from '../worktreeState'
import type { SvnUpdateTargets } from '../../svn/svnUpdateTargets'
import { SvnAssemblyReader, type SvnAssembly } from '../../svn/svnAssembly'

export function testAssembly(content = 'same', metadata = 'same', path = 'a.txt'): SvnAssembly {
  const nodes = [{ path, content, metadata }]
  return { format: 1, nodes, incoming: [], content: SvnAssemblyReader.hash(nodes.map(({ path, content }) => [path, content])),
    metadata: SvnAssemblyReader.hash(nodes.map(({ path, metadata }) => [path, metadata])) }
}

export const emptyUpdateTargets: Pick<SvnUpdateTargets, 'owner' | 'snapshot' | 'verify'> = {
  owner: async (path, revision) => ({ path, revision, url: 'https://svn.test/app', repository: 'https://svn.test', kind: 'dir', pinned: false }),
  snapshot: async () => ({ properties: {}, localMappingChanges: false, children: [], missing: [], mismatched: [] }),
  verify: async () => {},
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

export async function finishTestRecords(patch: Partial<WorktreeLifecycle> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jamat-finish-'))
  roots.push(root)
  const file = join(root, 'records.json')
  const options = { snapshotsDirectory: join(root, 'snapshots'), report: () => {} }
  const records = await SessionRecordsStore.load(file, options)
  await records.put({ sessionId: 'worker', kind: 'agent', title: 'Worker', life: 'live', binding: null,
    directory: { mode: 'default' }, createdAt: 1, agent: { agentId: 'claude', launchMode: 'new' },
    worktree: { kind: 'svn', repositoryRoot: root, worktreePath: join(root, '.worktrees', 'tree'), branch: 'url', baseCommit: 'r1' },
    worktreeLifecycle: { version: 1, actionId: 'finish', phase: 'finishing', step: 'worker-resolving', outOfDate: 0, journal: [],
      ...patch.step === 'committing' || patch.step === 'awaiting-idle' ? {
        execution: { root: join(root, '.worktrees', 'tree'), checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window' as const, startedAt: 1 },
        approvedAt: 1, review: { version: 1, selection: ['a'], hashes: { a: 'proof' }, message: '[app] Change', source: 'person-local' as const, acknowledged: [], headMovedBy: 0 },
        preparation: { format: 1 as const, manifest: 'fixture', content: testAssembly().content, metadata: testAssembly().metadata, commands: testAssembly().content, checkedAt: 1, checks: 'none' as const, attempt: 0 },
      } : {},
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } }, ...patch } })
  return { records, root, reload: () => SessionRecordsStore.load(file, options) }
}
