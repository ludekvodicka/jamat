import type { ComputerSession } from './computerTree';

export type PreviewKind = 'terminal' | 'transcript';

export class ComputerNavigation {
  selected: ComputerSession | null = null;
  previewKind: PreviewKind = 'terminal';
  private revision = 0;

  select(session: ComputerSession): void {
    this.selected = session;
    this.previewKind = session.life === 'live' ? 'terminal' : 'transcript';
    this.invalidate();
  }

  reconcile(sessions: readonly ComputerSession[]): 'none' | 'retained' | 'missing' {
    this.invalidate();
    if (this.selected === null) return 'none';
    const current = sessions.find(session => session.sessionId === this.selected!.sessionId);
    if (current === undefined) {
      this.selected = null;
      return 'missing';
    }
    this.selected = current;
    return 'retained';
  }

  close(): void {
    this.selected = null;
    this.invalidate();
  }

  begin(kind: PreviewKind): number {
    if (kind !== 'terminal' && kind !== 'transcript') throw new Error(`Unknown preview: ${kind}`);
    this.previewKind = kind;
    return ++this.revision;
  }

  accepts(revision: number): boolean {
    return this.selected !== null && revision === this.revision;
  }

  invalidate(): void {
    ++this.revision;
  }
}

export class ComputerExpansion {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly key: string;
  private readonly choices = new Map<string, boolean>();

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null, account: string, pcId: string) {
    this.storage = storage;
    this.key = `jamat:tree:1:${JSON.stringify([account, pcId])}`;
    try {
      const entries: unknown = JSON.parse(storage?.getItem(this.key) ?? '[]');
      if (Array.isArray(entries))
        for (const entry of entries)
          if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
            this.choices.set(entry[0], entry[1]);
    } catch {
      // Browsers may disable storage; navigation still works for the current page.
    }
  }

  expanded(key: string, kind: 'group' | 'category' | 'project', searching: boolean): boolean {
    if (searching) return true;
    return this.choices.get(key) ?? kind !== 'project';
  }

  set(key: string, expanded: boolean): boolean {
    this.choices.set(key, expanded);
    if (this.storage === null) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify([...this.choices]));
      return true;
    } catch {
      return false;
    }
  }
}
