import type { SessionLaunchInput, SessionLaunchOptions } from '../app/sessionLaunch';
import type { ComputerSession } from './computerTree';

export class SessionLaunchModel {
  static projects(options: SessionLaunchOptions) {
    const warnings: string[] = [];
    const groups = options.projects.categories.flatMap(({ category, listing }) => {
      if (!listing.ok) {
        warnings.push(`${category.label}: ${listing.detail}`);
        return [];
      }
      if (!category.available || !listing.value.available) {
        warnings.push(`${category.label}: složka není dostupná.`);
        return [];
      }
      if (listing.value.truncated) warnings.push(`${category.label}: seznam projektů je zkrácený.`);
      return [{ id: category.id, label: category.label, projects: listing.value.projects }];
    });
    return { groups, warnings };
  }

  static models(options: SessionLaunchOptions, agentId: SessionLaunchInput['agentId']) {
    const agent = options.agents?.agents.find(agent => agent.agentId === agentId);
    const models = [{ id: '', label: agent?.configuredModel ? `Výchozí na PC (${agent.configuredModel})` : 'Výchozí na PC' },
      ...(agent?.models.map(model => ({ id: model.id, label: model.label })) ?? [])];
    if (agent?.configuredModel && !models.some(model => model.id === agent.configuredModel))
      models.push({ id: agent.configuredModel, label: agent.configuredModel });
    return models;
  }
}

export class PendingSessionLaunch {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  private readonly key: string;
  private pending: SessionLaunchInput | null = null;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, account: string, pcId: string) {
    this.storage = storage;
    this.key = `jamat:launch:1:${JSON.stringify([account, pcId])}`;
    this.restore();
  }

  read(): SessionLaunchInput | null {
    return this.pending;
  }

  private restore(): void {
    try {
      const value = JSON.parse(this.storage?.getItem(this.key) ?? 'null');
      if (value && typeof value.operationId === 'string' && /^[\da-f-]{36}$/i.test(value.operationId)
          && typeof value.categoryId === 'string' && typeof value.projectPath === 'string' && typeof value.title === 'string'
          && (value.agentId === 'codex' || value.agentId === 'claude') && typeof value.worktree === 'boolean'
          && (value.model === null || typeof value.model === 'string'))
        this.pending = value;
    } catch { /* A blocked store still allows recovery within this page. */ }
  }

  begin(input: SessionLaunchInput): void {
    if (this.read()) throw new Error('Nejprve ověřte předchozí spuštění.');
    this.pending = input;
    try { this.storage?.setItem(this.key, JSON.stringify(input)); } catch { /* Keep the in-memory request. */ }
  }

  find(sessions: readonly ComputerSession[]): ComputerSession | undefined {
    const id = this.pending?.operationId;
    return id ? sessions.find(session => session.callerOperationId === id) : undefined;
  }

  clear(): void {
    this.pending = null;
    try { this.storage?.removeItem(this.key); } catch { /* Do not mask a confirmed result. */ }
  }
}
