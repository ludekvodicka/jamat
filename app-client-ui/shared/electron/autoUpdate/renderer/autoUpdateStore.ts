import type { DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import type { AutoUpdateApi } from "../common/autoUpdateApi";

export class AutoUpdateStore
{
  private readonly api: AutoUpdateApi;
  private readonly listeners: Set<() => void>;
  private status: DtoAutoUpdateStatus | null;
  private unsubscribe: (() => void) | undefined;

  constructor(api: AutoUpdateApi)
  {
    this.api = api;
    this.listeners = new Set();
    this.status = null;
    this.unsubscribe = undefined;
    // useSyncExternalStore calls these unbound and compares their identity.
    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = this.getSnapshot.bind(this);
  }

  start(): void
  {
    // Subscribe before the pull: a change sent while the pull is in flight wins over the stale pull answer.
    let changed = false;
    this.unsubscribe = this.api.onChanged(status =>
    {
      changed = true;
      this.set(status);
    });
    // A rejected pull (main has not registered the handlers yet) leaves the next push to deliver the state.
    void this.api.status().then(status =>
    {
      if (!changed)
        this.set(status);
    }, (error: unknown) => console.warn("Update status unavailable", error));
  }

  stop(): void
  {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  subscribe(listener: () => void): () => void
  {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): DtoAutoUpdateStatus | null
  {
    return this.status;
  }

  private set(status: DtoAutoUpdateStatus): void
  {
    this.status = status;
    for (const listener of this.listeners)
      listener();
  }
}
