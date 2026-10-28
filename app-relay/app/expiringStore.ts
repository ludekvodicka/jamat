import { randomBytes } from 'node:crypto';

export class ExpiringStore<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  private readonly lifetimeMs: number;

  constructor(lifetimeMs: number) {
    this.lifetimeMs = lifetimeMs;
  }

  create(value: T): string {
    this.prune();
    if (this.entries.size >= 1000)
      throw new Error('Too many active sessions.');
    const id = randomBytes(32).toString('base64url');
    this.entries.set(id, { value, expires: Date.now() + this.lifetimeMs });
    return id;
  }

  get(id: string | undefined): T | undefined {
    if (!id)
      return undefined;
    const entry = this.entries.get(id);
    if (entry && entry.expires > Date.now())
      return entry.value;
    this.entries.delete(id);
    return undefined;
  }

  delete(id: string | undefined): void {
    if (id)
      this.entries.delete(id);
  }

  private prune(): void {
    for (const [id, entry] of this.entries)
      if (entry.expires <= Date.now())
        this.entries.delete(id);
  }
}
