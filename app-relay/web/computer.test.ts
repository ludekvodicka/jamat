import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerTree, type ComputerNode, type ComputerSession, type ComputerSnapshot } from './computerTree';
import { ComputerExpansion, ComputerNavigation } from './computerNavigation';

const session = (id: string, changes: Partial<ComputerSession> = {}): ComputerSession => ({
  sessionId: id, title: id, tabTitle: `Project - ${id}`, titleParts: { number: null, name: id },
  kind: 'agent', agent: { agentId: 'codex' }, directory: { mode: 'default' },
  project: { kind: 'project', categoryId: 'apps', projectName: 'Project', projectPath: 'Q:/Apps/Project' },
  life: 'live', activity: 'idle', admits: [], ...changes,
});
const snapshot = (sessions: ComputerSession[]): ComputerSnapshot => ({
  revision: 1, reconciled: true, host: { presence: 'running', hostVersion: 'fixture', hostInstanceId: 'fixture', liveCount: sessions.length, lastStartError: null },
  categories: [{ id: 'apps', label: 'Applications', path: 'Q:/Apps' }], sessions, orphans: [],
  sessionGroups: [{ id: 'waiting', title: 'Na mě' }, { id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' }],
});
function flatten(nodes: ComputerNode[]): ComputerNode[] {
  return nodes.flatMap(node => [node, ...flatten(node.children)]);
}
const sessionsOf = (nodes: ComputerNode[]) => flatten(nodes).filter(node => node.kind === 'session').map(node => node.session.sessionId);

test('source group names/order and category/project hierarchy retain each session exactly once', () => {
  const data = snapshot([session('z'), session('a', { group: 'waiting' }), session('b')]);
  const tree = ComputerTree.build(data, '', 'live');
  assert.deepEqual(tree.map(node => node.kind === 'group' ? node.label : null), ['Na mě', 'Sessions']);
  assert.deepEqual(tree.map(node => node.count), [1, 2]);
  assert.deepEqual(sessionsOf(tree), ['a', 'b', 'z']);
  assert.deepEqual(flatten(tree).flatMap(node => node.kind === 'project' ? [node.label] : []), ['Project', 'Project']);
});

test('legacy snapshots keep categories; invalid group metadata does not masquerade as legacy', () => {
  const data = snapshot([session('a')]);
  delete data.sessionGroups;
  assert.equal(ComputerTree.build(data, '', 'all')[0].kind, 'category');
  data.sessionGroups = [{ id: 'none', title: 'Sessions' }];
  assert.throws(() => ComputerTree.build(data, '', 'all'), /neplatný/);
  data.sessionGroups = snapshot([]).sessionGroups;
  data.sessions = [session('a', { group: 'missing' })];
  assert.throws(() => ComputerTree.build(data, '', 'all'), /definici skupiny/);
});

test('project identity distinguishes equal labels and POSIX case but folds Windows case and worktree directories', () => {
  const data = snapshot([
    session('a'), session('b', { project: { kind: 'project', categoryId: 'apps', projectName: 'Project', projectPath: 'q:\\apps\\project\\' }, directory: { mode: 'adHoc', path: 'Q:/Apps/Project/.worktrees/b' } }),
    session('c', { project: { kind: 'project', categoryId: 'apps', projectName: 'Project', projectPath: 'Q:/Elsewhere/Project' } }),
    session('d', { project: { kind: 'adHoc', path: '/src/One' } }),
    session('e', { project: { kind: 'adHoc', path: '/src/one' } }),
    session('f', { project: { kind: 'none' } }),
  ]);
  const tree = flatten(ComputerTree.build(data, '', 'all'));
  assert.deepEqual(tree.filter(node => node.kind === 'project').map(node => node.count), [2, 1, 1, 1]);
  assert.ok(tree.some(node => node.kind === 'category' && node.label === 'NO PROJECT'));
  assert.equal(new Set(sessionsOf(ComputerTree.build(data, '', 'all'))).size, 6);
});

test('children follow the parent group and remain findable when the parent is filtered out', () => {
  const data = snapshot([session('parent', { group: 'waiting', life: 'ended' }),
    session('child', { parent: { sessionId: 'parent', kind: 'worker', sameProject: true } })]);
  const all = ComputerTree.build(data, '', 'all');
  const parent = flatten(all).find(node => node.kind === 'session' && node.session.sessionId === 'parent')!;
  assert.deepEqual(sessionsOf(parent.children), ['child']);
  assert.deepEqual(sessionsOf(ComputerTree.build(data, '', 'live')), ['child']);
  assert.deepEqual(sessionsOf(ComputerTree.build(data, 'child', 'all')), ['child']);
  assert.equal(ComputerTree.build(data, 'child', 'all')[0].key, 'group:waiting');
});

test('cycles, cross-project links and missing parents never hide sessions', () => {
  const data = snapshot([
    session('a', { parent: { sessionId: 'b', kind: 'worker', sameProject: true } }),
    session('b', { parent: { sessionId: 'a', kind: 'worker', sameProject: true } }),
    session('c', { parent: { sessionId: 'a', kind: 'worker', sameProject: false } }),
    session('d', { parent: { sessionId: 'missing', kind: 'ticket', sameProject: true } }),
  ]);
  const rows = flatten(ComputerTree.build(data, '', 'all')).filter(node => node.kind === 'session');
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.children.length === 0));
});

test('search matches project metadata rather than relying on tab titles, and lifecycle controls status', () => {
  const data = snapshot([session('a', { tabTitle: 'Unrelated', activity: 'waiting' }), session('b', { life: 'ended', activity: 'working' })]);
  assert.deepEqual(sessionsOf(ComputerTree.build(data, 'q:/apps/project', 'live')), ['a']);
  assert.equal(ComputerTree.status(data.sessions[0]), 'Čeká na odpověď');
  assert.equal(ComputerTree.status(data.sessions[1]), 'Ukončená');
  assert.deepEqual(ComputerTree.build(data, 'absent', 'all'), []);
});

test('a refresh retains selection and preview mode but invalidates pending responses', () => {
  const state = new ComputerNavigation();
  state.select(session('a'));
  const old = state.begin('transcript');
  assert.equal(state.reconcile([session('a', { title: 'Renamed', life: 'ended' })]), 'retained');
  assert.equal(state.previewKind, 'transcript');
  assert.equal(state.selected?.title, 'Renamed');
  assert.equal(state.accepts(old), false);
  const current = state.begin('transcript');
  assert.equal(state.accepts(current), true);
  assert.equal(state.reconcile([]), 'missing');
  assert.equal(state.selected, null);
  assert.equal(state.accepts(current), false);
});

test('switching sessions, preview tabs, and closing refuse late answers', () => {
  const state = new ComputerNavigation();
  state.select(session('a'));
  const a = state.begin('terminal');
  state.select(session('b'));
  assert.equal(state.accepts(a), false);
  const terminal = state.begin('terminal');
  const transcript = state.begin('transcript');
  assert.equal(state.accepts(terminal), false);
  assert.equal(state.accepts(transcript), true);
  state.close();
  assert.equal(state.accepts(transcript), false);
});

test('expansion is isolated by account and PC; searching never overwrites collapsed choices', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const first = new ComputerExpansion(storage, 'one', 'pc');
  assert.equal(first.expanded('project', 'project', false), false);
  assert.equal(first.expanded('category', 'category', false), true);
  first.set('project', true);
  first.set('category', false);
  assert.equal(first.expanded('category', 'category', true), true);
  assert.equal(first.expanded('category', 'category', false), false);
  assert.equal(new ComputerExpansion(storage, 'one', 'pc').expanded('project', 'project', false), true);
  assert.equal(new ComputerExpansion(storage, 'two', 'pc').expanded('project', 'project', false), false);
  assert.equal(new ComputerExpansion(storage, 'one', 'other').expanded('project', 'project', false), false);
});

test('disabled and malformed browser storage do not prevent in-page navigation', () => {
  const disabled = new ComputerExpansion(null, 'one', 'pc');
  assert.equal(disabled.set('project', true), false);
  assert.equal(disabled.expanded('project', 'project', false), true);
  const malformed = new ComputerExpansion({ getItem: () => '{bad', setItem: () => { throw new Error('Quota'); } }, 'one', 'pc');
  assert.equal(malformed.set('project', true), false);
  assert.equal(malformed.expanded('project', 'project', false), true);
});
