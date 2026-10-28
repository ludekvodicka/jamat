import { describe, expect, it } from 'vitest';
import { SessionTreeHierarchy as Hierarchy, type SessionTreeEntry } from './sessionTreeHierarchy';

function entry(id: string, changes: Partial<SessionTreeEntry['info']> = {}): SessionTreeEntry {
  return { info: { sessionId: id, title: id, project: { kind: 'none' }, ...changes } };
}

describe('shared session hierarchy', () => {
  it('keeps the catalog order and separate reserved roots even when category ids coincide', () => {
    const tree = Hierarchy.categories([
      entry('z', { project: { kind: 'project', categoryId: 'adhoc', projectPath: 'Q:/z', projectName: 'Z' } }),
      entry('b', { project: { kind: 'project', categoryId: 'b', projectPath: 'Q:/b', projectName: 'B' } }),
      entry('a', { project: { kind: 'adHoc', path: 'Q:/loose/' } }), entry('none'),
    ], [{ id: 'b', label: 'First', path: 'Q:/' }, { id: 'adhoc', label: 'Second', path: 'Q:/' }]);
    expect(tree.map(row => row.id)).toEqual(['category:b', 'category:adhoc', 'root:adhoc', 'root:none']);
    expect(tree[2].projects[0].label).toBe('loose');
  });

  it('honors nesting settings and limits session ancestry without losing a grandchild', () => {
    const parent = entry('parent');
    const child = entry('child', { parent: { sessionId: 'parent', kind: 'worktree', sameProject: true } });
    const grandchild = entry('grandchild', { parent: { sessionId: 'child', kind: 'worker', sameProject: true } });
    const links = Hierarchy.linksOf([parent, child, grandchild]);
    expect([...links.keys()]).toEqual(['child']);
    expect(Hierarchy.sectionOf(child, links)).toBe(parent);
    expect(Hierarchy.childrenByParent([child], links).size).toBe(0);
    expect(Hierarchy.linksOf([parent, child], { subagents: true, worktrees: false, tickets: true }).size).toBe(0);
  });

  it('sorts titles with an id tie-break and preserves absolute path semantics across platforms', () => {
    expect(Hierarchy.sorted([entry('z', { title: 'A' }), entry('a', { title: 'A' }), entry('b', { title: 'B' })])
      .map(row => row.info.sessionId)).toEqual(['a', 'z', 'b']);
    expect(Hierarchy.projectKeyOf('c', 'Q:\\Apps\\One\\')).toBe(Hierarchy.projectKeyOf('c', 'q:/apps/one'));
    expect(Hierarchy.projectKeyOf('c', '/apps/One')).not.toBe(Hierarchy.projectKeyOf('c', '/apps/one'));
  });
});
