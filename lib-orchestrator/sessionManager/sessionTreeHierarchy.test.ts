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

  it('nests sessions several levels deep and files each under the top of its family', () => {
    const parent = entry('parent');
    const child = entry('child', { parent: { sessionId: 'parent', kind: 'worktree', sameProject: true } });
    const grandchild = entry('grandchild', { parent: { sessionId: 'child', kind: 'worker', sameProject: true } });
    const great = entry('great', { parent: { sessionId: 'grandchild', kind: 'worker', sameProject: true } });
    const links = Hierarchy.linksOf([parent, child, grandchild, great]);
    expect([...links.keys()]).toEqual(['child', 'grandchild', 'great']);
    expect(Hierarchy.sectionOf(child, links)).toBe(parent);
    expect(Hierarchy.sectionOf(great, links)).toBe(parent);
    expect(Hierarchy.childrenByParent([child, grandchild], links).get('child')).toEqual([grandchild]);
    expect(Hierarchy.linksOf([parent, child], { subagents: true, worktrees: false, tickets: true }).size).toBe(0);
  });

  it('leaves the sessions of a parent cycle as roots and still nests a child hanging off it', () => {
    const a = entry('a', { parent: { sessionId: 'b', kind: 'worker', sameProject: true } });
    const b = entry('b', { parent: { sessionId: 'a', kind: 'worker', sameProject: true } });
    const c = entry('c', { parent: { sessionId: 'a', kind: 'worker', sameProject: true } });
    const links = Hierarchy.linksOf([a, b, c]);
    expect([...links.keys()]).toEqual(['c']);
    expect(Hierarchy.sectionOf(c, links)).toBe(a);
  });

  it('sorts titles with an id tie-break and preserves absolute path semantics across platforms', () => {
    expect(Hierarchy.sorted([entry('z', { title: 'A' }), entry('a', { title: 'A' }), entry('b', { title: 'B' })])
      .map(row => row.info.sessionId)).toEqual(['a', 'z', 'b']);
    expect(Hierarchy.projectKeyOf('c', 'Q:\\Apps\\One\\')).toBe(Hierarchy.projectKeyOf('c', 'q:/apps/one'));
    expect(Hierarchy.projectKeyOf('c', '/apps/One')).not.toBe(Hierarchy.projectKeyOf('c', '/apps/one'));
  });
});
