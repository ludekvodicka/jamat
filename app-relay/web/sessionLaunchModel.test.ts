import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionLaunchInput, SessionLaunchOptions } from '../app/sessionLaunch';
import type { ComputerSession } from './computerTree';
import { PendingSessionLaunch, SessionLaunchModel } from './sessionLaunchModel';

const input: SessionLaunchInput = { operationId: '00000000-0000-4000-8000-000000000001',
  categoryId: 'apps', projectPath: 'Q:/Apps/Jamat', title: 'Task', agentId: 'codex', model: null, worktree: false };
const options: SessionLaunchOptions = { createAvailable: true, projects: { categories: [] }, agents: { agents: [
  { agentId: 'codex', configuredModel: 'custom-model', models: [{ id: 'codex-model', label: 'Target Codex', kind: 'version', context: 100, efforts: [] }] },
  { agentId: 'claude', configuredModel: 'opus', models: [{ id: 'opus', label: 'Target Claude', kind: 'alias', context: 100, efforts: [] }] },
] } };

test('models come from the selected agent on the target, including an unlisted configured default', () => {
  assert.deepEqual(SessionLaunchModel.models(options, 'codex'), [
    { id: '', label: 'Výchozí na PC (custom-model)' }, { id: 'codex-model', label: 'Target Codex' }, { id: 'custom-model', label: 'custom-model' },
  ]);
  assert.deepEqual(SessionLaunchModel.models(options, 'claude').map(model => model.id), ['', 'opus']);
  assert.deepEqual(SessionLaunchModel.models({ ...options, agents: null }, 'codex'), [{ id: '', label: 'Výchozí na PC' }]);
});

test('project choices retain category identity and report unavailable or truncated catalogs', () => {
  const category = { id: 'apps', label: 'Applications', path: 'Q:/Apps', available: true };
  const project = { name: 'Group/Jamat', path: input.projectPath, lastActivity: null };
  const result = SessionLaunchModel.projects({ ...options, projects: { categories: [
    { category, listing: { ok: true, value: { projects: [project], entries: [], virtualFolders: [], truncated: true, available: true } } },
    { category: { ...category, id: 'offline', label: 'Offline' }, listing: { ok: false, code: 'category-unavailable', detail: 'Cannot read' } },
    { category: { ...category, id: 'missing', available: false }, listing: { ok: true, value: { projects: [], entries: [], virtualFolders: [], truncated: false, available: false } } },
  ] } });
  assert.deepEqual(result.groups, [{ id: 'apps', label: 'Applications', projects: [project] }]);
  assert.equal(result.warnings.length, 3);
});

test('an uncertain launch survives reload, is scoped to user and PC, and resolves only by operation ID', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const pending = new PendingSessionLaunch(storage, 'user', 'pc');
  pending.begin(input);
  assert.throws(() => pending.begin({ ...input, title: 'Duplicate' }));
  const reloaded = new PendingSessionLaunch(storage, 'user', 'pc');
  assert.deepEqual(reloaded.read(), input);
  assert.equal(new PendingSessionLaunch(storage, 'other', 'pc').read(), null);
  assert.equal(new PendingSessionLaunch(storage, 'user', 'other-pc').read(), null);
  const session = { sessionId: 'session', title: input.title, callerOperationId: input.operationId } as ComputerSession;
  assert.equal(reloaded.find([{ ...session, callerOperationId: null }]), undefined);
  assert.equal(reloaded.find([session]), session);
  reloaded.clear();
  assert.equal(new PendingSessionLaunch(storage, 'user', 'pc').read(), null);
});

test('blocked or corrupted storage cannot erase the current request or resurrect a confirmed one', () => {
  const storage = { getItem: () => '{bad json', setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  const pending = new PendingSessionLaunch(storage, 'user', 'pc');
  assert.equal(pending.read(), null);
  pending.begin(input);
  assert.deepEqual(pending.read(), input);
  pending.clear();
  assert.equal(pending.read(), null);
  const stale = new PendingSessionLaunch({ ...storage, getItem: () => JSON.stringify(input) }, 'user', 'pc');
  stale.clear();
  assert.equal(stale.read(), null);
});
