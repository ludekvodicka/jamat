import { describe, it } from "vitest";
import { expect } from "chai";
import { AutoUpdateConst } from "../common/autoUpdateApi";
import type { AutoUpdateLogHandler, AutoUpdateReleasePageUrl } from "./autoUpdate.types";
import { AutoUpdateIpc } from "./autoUpdateIpc";
import { AutoUpdateManager } from "./autoUpdateManager";

type Handler = () => unknown;

function createIpc(releasePageUrl: AutoUpdateReleasePageUrl | null)
{
  const handlers = new Map<string, Handler>();
  const sent: { window: string; channel: string }[] = [];
  const opened: string[] = [];
  const warnings: string[] = [];
  const log: AutoUpdateLogHandler = { info: () => undefined, warn: message => warnings.push(message), error: () => undefined };
  const manager = new AutoUpdateManager(null, {
    resolution: { mode: "off", reason: "Development run" },
    running: "1.0.0",
    backgroundChecks: false,
    initialDelayMs: 0,
    intervalMs: 0,
    releasePageUrl,
    log,
  });
  const window = (name: string, destroyed: boolean) => ({
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string) => sent.push({ window: name, channel }) },
  });
  const windows = [window("main", false), window("closed", true), window("second", false)];
  const ipc = new AutoUpdateIpc(manager, {
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as ConstructorParameters<typeof AutoUpdateIpc>[1]["ipcMain"],
    windows: () => windows as unknown as ReturnType<ConstructorParameters<typeof AutoUpdateIpc>[1]["windows"]>,
    shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } },
    allowedHosts: ["github.com"],
    log,
  });
  return { ipc, manager, handlers, sent, opened, warnings };
}

describe("electron/autoUpdate/main/AutoUpdateIpc", () =>
{
  it("registers and removes the four handlers", () =>
  {
    const { ipc, handlers } = createIpc(null);
    ipc.register();
    expect([...handlers.keys()]).to.have.members([AutoUpdateConst.channelStatus, AutoUpdateConst.channelCheck,
      AutoUpdateConst.channelInstall, AutoUpdateConst.channelOpenReleasePage]);
    ipc.unregister();
    expect(handlers.size).to.equal(0);
  });

  it("broadcasts every change to every live window and stops after unregister", () =>
  {
    const { ipc, manager, sent } = createIpc(null);
    ipc.register();
    manager.start();
    expect(sent).to.deep.equal([{ window: "main", channel: AutoUpdateConst.channelChanged }, { window: "second", channel: AutoUpdateConst.channelChanged }]);
    ipc.unregister();
    manager.start();
    expect(sent).to.have.length(2);
  });

  it("answers the status channel", () =>
  {
    const { ipc, manager, handlers } = createIpc(null);
    ipc.register();
    manager.start();
    expect(handlers.get(AutoUpdateConst.channelStatus)?.()).to.deep.equal(manager.getStatus());
  });

  it("opens an https GitHub release page", async () =>
  {
    const { ipc, handlers, opened } = createIpc(() => "https://github.com/owner/repo/releases");
    ipc.register();
    await handlers.get(AutoUpdateConst.channelOpenReleasePage)?.();
    expect(opened).to.deep.equal(["https://github.com/owner/repo/releases"]);
  });

  it("refuses http, other hosts and a malformed URL with a warning", async () =>
  {
    for (const url of ["http://github.com/owner/repo/releases", "https://example.com/releases", "not a url"])
    {
      const { ipc, handlers, opened, warnings } = createIpc(() => url);
      ipc.register();
      await handlers.get(AutoUpdateConst.channelOpenReleasePage)?.();
      expect(opened).to.deep.equal([]);
      expect(warnings).to.deep.equal([`Release page refused: ${url}`]);
    }
  });

  it("does nothing without a release page", async () =>
  {
    const { ipc, handlers, opened, warnings } = createIpc(null);
    ipc.register();
    await handlers.get(AutoUpdateConst.channelOpenReleasePage)?.();
    expect(opened).to.deep.equal([]);
    expect(warnings).to.deep.equal([]);
  });
});
