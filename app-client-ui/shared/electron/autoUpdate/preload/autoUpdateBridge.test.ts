import { describe, it } from "vitest";
import { expect } from "chai";
import type { DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import { AutoUpdateConst } from "../common/autoUpdateApi";
import { AutoUpdateBridge } from "./autoUpdateBridge";

type Handler = (event: unknown, status: DtoAutoUpdateStatus) => void;

function createIpcRenderer()
{
  const invoked: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const ipcRenderer = {
    invoke: (channel: string) => { invoked.push(channel); return Promise.resolve(); },
    on: (channel: string, handler: Handler) => { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); return ipcRenderer; },
    removeListener: (channel: string, handler: Handler) => { handlers.set(channel, (handlers.get(channel) ?? []).filter(item => item !== handler)); return ipcRenderer; },
  };
  return { ipcRenderer, invoked, handlers };
}

describe("electron/autoUpdate/preload/AutoUpdateBridge", () =>
{
  it("invokes one channel per method", async () =>
  {
    const { ipcRenderer, invoked } = createIpcRenderer();
    const api = AutoUpdateBridge.create(ipcRenderer as unknown as Parameters<typeof AutoUpdateBridge.create>[0]);
    await api.status();
    await api.check();
    await api.install();
    await api.openReleasePage();
    expect(invoked).to.deep.equal([AutoUpdateConst.channelStatus, AutoUpdateConst.channelCheck,
      AutoUpdateConst.channelInstall, AutoUpdateConst.channelOpenReleasePage]);
  });

  it("forwards changes and removes the same handler on unsubscribe", () =>
  {
    const { ipcRenderer, handlers } = createIpcRenderer();
    const api = AutoUpdateBridge.create(ipcRenderer as unknown as Parameters<typeof AutoUpdateBridge.create>[0]);
    const received: DtoAutoUpdateStatus[] = [];
    const unsubscribe = api.onChanged(status => received.push(status));
    const status: DtoAutoUpdateStatus = { running: "1.0.0", mode: "off", releasePage: false, state: { kind: "idle" } };
    for (const handler of handlers.get(AutoUpdateConst.channelChanged) ?? [])
      handler({}, status);
    expect(received).to.deep.equal([status]);
    unsubscribe();
    expect(handlers.get(AutoUpdateConst.channelChanged)).to.deep.equal([]);
  });
});
