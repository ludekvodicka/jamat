import { vi } from 'vitest'
import type { SnapinContext, AttemptRecord } from '../shared/snapinContract'

export function context(): SnapinContext {
  return { log: vi.fn(), now: () => 100,
    projects: { projects: vi.fn(async () => []) },
    svn: { urlOf: vi.fn(async () => ({ ok: true as const, value: 'https://svn/project' })),
      listAtHead: vi.fn(async () => ({ ok: true as const, value: [] })), changedNames: vi.fn(async () => ({ ok: true as const, value: [] })) },
    sessions: { snapshot: vi.fn(() => ({ revision: 0, reconciled: true, sessions: [], categories: [], orphans: [],
      host: { presence: 'running' as const, hostVersion: null, hostInstanceId: null, liveCount: 0, lastStartError: null } })),
      versioningMode: vi.fn(() => 'checkpoints' as const), openTerminal: async () => 'missing-session',
      createSession: async () => { throw new Error('Unexpected create') },
      worktreeResults: vi.fn(async () => ({ ok: true as const, value: { results: [] } })),
      acknowledgeWorktreeResult: async (actionId) => ({ ok: true, value: { actionId } }) } }
}

export function attempt(): AttemptRecord {
  return { attemptId: '1234abcd-test', itemKey: 'review-todos:project:900', title: 'Todo 900: scratch', mode: 'wt',
    projectDirectory: 'project', agentId: 'claude', phase: 'review', createdAt: 1, appliedThrough: 0, group: 'project', leaseHeld: false }
}
