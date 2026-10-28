import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionLaunch, type SessionLaunchInput } from './sessionLaunch.js';

const input: SessionLaunchInput = { operationId: '00000000-0000-4000-8000-000000000001',
  categoryId: 'apps', projectPath: 'Q:/Apps/Jamat', title: 'My task', agentId: 'codex', model: null, worktree: false };

test('launcher composes only a new agent session and preserves the caller operation ID', () => {
  const first = SessionLaunch.request(input);
  const second = SessionLaunch.request(input);
  assert.equal(first.operationId, input.operationId);
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(first.body, { spec: { kind: 'agent',
    directory: { mode: 'project', categoryId: 'apps', projectPath: input.projectPath }, title: input.title,
    agent: { agentId: 'codex', mode: 'new' } } });
  const worktree = SessionLaunch.request({ ...input, agentId: 'claude', model: 'opus', worktree: true });
  assert.deepEqual(worktree.body.spec.agent, { agentId: 'claude', mode: 'new', model: 'opus' });
  assert.deepEqual(worktree.body.spec.worktree, { slug: input.title });
});

test('launcher rejects arbitrary operations, invalid model arguments and incomplete forms', () => {
  for (const change of [{ operationId: 'invalid' }, { categoryId: '' }, { projectPath: '' }, { title: '   ' },
    { title: 'line\nbreak' }, { title: 'x'.repeat(257) }, { agentId: 'shell' }, { model: '--unsafe value' },
    { worktree: 'true' }, { mode: 'fork' }, { acknowledgeSetup: true }, { openTab: true }, { command: 'anything' }])
    assert.throws(() => SessionLaunch.request({ ...input, ...change }));
});
