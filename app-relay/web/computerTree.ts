import { SessionTreeHierarchy as Hierarchy } from '../../lib-orchestrator/sessionManager/sessionTreeHierarchy';
import { SessionGroups } from '../../lib-orchestrator/sessionManager/sessionGroups';
import type { RemoteControlOperationMap } from '../../lib-orchestrator/remoteControl/remoteControlApi.types';

export type ComputerSnapshot = RemoteControlOperationMap['sessions.list']['response'];
export type ComputerSession = ComputerSnapshot['sessions'][number];
export type ComputerFilter = 'live' | 'all';
export type ComputerNode =
  | { kind: 'group' | 'category' | 'project'; key: string; collapseKey: string; label: string; count: number; children: ComputerNode[] }
  | { kind: 'session'; key: string; session: ComputerSession; count: number; children: ComputerNode[] };

export class ComputerTree {
  static build(snapshot: ComputerSnapshot, search: string, filter: ComputerFilter): ComputerNode[] {
    if (filter !== 'live' && filter !== 'all') throw new Error(`Unknown filter: ${filter}`);
    const groups = snapshot.sessionGroups;
    if (groups !== undefined && !SessionGroups.isList(groups))
      throw new Error('Počítač vrátil neplatný seznam skupin.');
    const entries = snapshot.sessions.map(info => ({ info, group: info.group ?? 'none' }));
    const links = Hierarchy.linksOf(entries);
    const query = search.trim().toLocaleLowerCase();
    const matches = ({ info }: typeof entries[number]) =>
      (filter === 'all' || info.life === 'live' || info.life === 'starting')
      && `${info.title} ${info.tabTitle} ${Hierarchy.projectTextOf(info.project)}`.toLocaleLowerCase().includes(query);
    const matching = entries.filter(entry => {
      const link = links.get(entry.info.sessionId);
      return matches(entry) || (link?.via === 'script' && matches(link.parent));
    });
    const children = Hierarchy.childrenByParent(matching, links);
    const nested = new Set([...children.values()].flat().map(entry => entry.info.sessionId));
    const roots = matching.filter(entry => !nested.has(entry.info.sessionId));
    const rows = (list: readonly typeof entries[number][]): ComputerNode[] => Hierarchy.sorted(list).map(entry => {
      const descendants = rows(children.get(entry.info.sessionId) ?? []);
      return { kind: 'session', key: `session:${entry.info.sessionId}`, session: entry.info,
        count: 1 + ComputerTree.count(descendants), children: descendants };
    });
    const categories = (list: readonly typeof entries[number][], prefix: string): ComputerNode[] =>
      Hierarchy.categories(list, snapshot.categories).map(category => ComputerTree.branch('category',
        `${prefix}/${category.id}`, category.id, category.label, [
          ...category.projects.map(project => ComputerTree.branch('project', `${prefix}/${project.id}`,
            project.id, project.label, rows(project.entries))),
          ...rows(category.sessions),
        ]));
    if (groups === undefined)
      return categories(roots, 'ungrouped');
    const byGroup = new Map(groups.map(group => [group.id, [] as typeof entries]));
    for (const entry of roots) {
      const group = Hierarchy.sectionOf(entry, links).group;
      const list = byGroup.get(group);
      if (list === undefined)
        throw new Error(`Počítač neposkytl definici skupiny ${group}. Obnovte seznam.`);
      list.push(entry);
    }
    return groups.flatMap(group => {
      const list = byGroup.get(group.id)!;
      return list.length === 0 ? [] : [ComputerTree.branch('group', `group:${group.id}`, `group:${group.id}`,
        group.title, categories(list, group.id))];
    });
  }

  static status(session: ComputerSession): string {
    switch (session.life) {
      case 'starting': return 'Spouští se';
      case 'ended': return 'Ukončená';
      case 'lost': return 'Přerušená';
      case 'live': {
        if (session.kind === 'shell') return 'Terminál běží';
        else if (session.kind !== 'agent') throw new Error(`Unknown session kind: ${session.kind}`);
        switch (session.activity) {
          case 'working': return session.compacting ? 'Zkracuje kontext' : session.activityDetail === 'background' ? 'Pracuje na pozadí' : 'Pracuje';
          case 'waiting': return 'Čeká na odpověď';
          case 'idle': return 'Nečinná';
          case 'unknown':
          case null: return 'Neznámá aktivita';
          default: throw new Error(`Unknown session activity: ${session.activity}`);
        }
      }
      default: throw new Error(`Unknown session life: ${session.life}`);
    }
  }

  private static branch(kind: 'group' | 'category' | 'project', key: string, collapseKey: string,
    label: string, children: ComputerNode[]): ComputerNode {
    return { kind, key, collapseKey, label, children, count: ComputerTree.count(children) };
  }

  private static count(nodes: ComputerNode[]): number {
    return nodes.reduce((total, node) => total + node.count, 0);
  }
}
