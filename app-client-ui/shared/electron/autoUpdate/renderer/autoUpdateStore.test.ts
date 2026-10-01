import { describe, it, vi } from "vitest";
import { expect } from "chai";
import type { DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import type { AutoUpdateApi } from "../common/autoUpdateApi";
import { AutoUpdateStore } from "./autoUpdateStore";

const idle: DtoAutoUpdateStatus = { running: "1.0.0", mode: "automatic", releasePage: false, state: { kind: "idle" } };
const checking: DtoAutoUpdateStatus = { ...idle, state: { kind: "checking" } };

function createApi()
{
  let answer: (status: DtoAutoUpdateStatus) => void = () => undefined;
  let changed: ((status: DtoAutoUpdateStatus) => void) | null = null;
  const api: AutoUpdateApi = {
    status: () => new Promise(resolve => { answer = resolve; }),
    check: () => Promise.resolve(),
    install: () => Promise.resolve(),
    openReleasePage: () => Promise.resolve(),
    onChanged: listener =>
    {
      changed = listener;
      return () => { changed = null; };
    },
  };
  return { api, answer: (status: DtoAutoUpdateStatus) => answer(status), change: (status: DtoAutoUpdateStatus) => changed?.(status), isSubscribed: () => changed !== null };
}

describe("electron/autoUpdate/renderer/AutoUpdateStore", () =>
{
  it("applies the pull answer and notifies", async () =>
  {
    const { api, answer } = createApi();
    const store = new AutoUpdateStore(api);
    let notified = 0;
    store.subscribe(() => notified++);
    store.start();
    expect(store.getSnapshot()).to.equal(null);
    answer(idle);
    await Promise.resolve();
    expect(store.getSnapshot()).to.equal(idle);
    expect(notified).to.equal(1);
  });

  it("keeps a change that arrives during the pull over the stale pull answer", async () =>
  {
    const { api, answer, change } = createApi();
    const store = new AutoUpdateStore(api);
    store.start();
    change(checking);
    answer(idle);
    await Promise.resolve();
    expect(store.getSnapshot()).to.equal(checking);
  });

  it("survives a rejected pull and takes the next push", async () =>
  {
    const { api, change } = createApi();
    api.status = () => Promise.reject(new Error("No handler registered for 'autoUpdate:status'"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new AutoUpdateStore(api);
    store.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).to.equal(null);
    expect(warn.mock.calls).to.have.length(1);
    change(idle);
    expect(store.getSnapshot()).to.equal(idle);
    warn.mockRestore();
  });

  it("unsubscribes on stop", () =>
  {
    const { api, isSubscribed } = createApi();
    const store = new AutoUpdateStore(api);
    store.start();
    expect(isSubscribed()).to.equal(true);
    store.stop();
    expect(isSubscribed()).to.equal(false);
  });

  it("keeps the identity of subscribe and getSnapshot", () =>
  {
    const store = new AutoUpdateStore(createApi().api);
    const { subscribe, getSnapshot } = store;
    expect(store.subscribe).to.equal(subscribe);
    expect(store.getSnapshot).to.equal(getSnapshot);
    expect(getSnapshot()).to.equal(null);
  });
});
