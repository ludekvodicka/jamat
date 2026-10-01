import type { BrowserWindow, IpcMain, Shell } from "electron";
import { AutoUpdateConst } from "../common/autoUpdateApi";
import type { AutoUpdateLogHandler } from "./autoUpdate.types";
import type { AutoUpdateManager } from "./autoUpdateManager";

export interface AutoUpdateIpcOptions
{
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  windows: () => readonly Pick<BrowserWindow, "webContents" | "isDestroyed">[];
  shell: Pick<Shell, "openExternal">;
  allowedHosts: readonly string[];
  log: AutoUpdateLogHandler;
}

export class AutoUpdateIpc
{
  private static readonly handledChannelsConst: readonly string[] = [
    AutoUpdateConst.channelStatus, AutoUpdateConst.channelCheck, AutoUpdateConst.channelInstall, AutoUpdateConst.channelOpenReleasePage,
  ];

  private readonly manager: AutoUpdateManager;
  private readonly options: AutoUpdateIpcOptions;
  private unsubscribe: (() => void) | undefined;

  constructor(manager: AutoUpdateManager, options: AutoUpdateIpcOptions)
  {
    this.manager = manager;
    this.options = options;
    this.unsubscribe = undefined;
  }

  register(): void
  {
    const ipc = this.options.ipcMain;
    ipc.handle(AutoUpdateConst.channelStatus, () => this.manager.getStatus());
    ipc.handle(AutoUpdateConst.channelCheck, () => this.manager.check());
    ipc.handle(AutoUpdateConst.channelInstall, () => this.manager.install());
    ipc.handle(AutoUpdateConst.channelOpenReleasePage, () => this.openReleasePage());
    // Broadcast instead of holding one window: a reload or a second window receives the state without new wiring.
    this.unsubscribe = this.manager.subscribe(status =>
    {
      for (const window of this.options.windows())
        if (!window.isDestroyed())
          window.webContents.send(AutoUpdateConst.channelChanged, status);
    });
  }

  unregister(): void
  {
    for (const channel of AutoUpdateIpc.handledChannelsConst)
      this.options.ipcMain.removeHandler(channel);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async openReleasePage(): Promise<void>
  {
    // The URL is composed in main from the current state; the renderer never supplies one.
    const url = this.manager.releasePageUrl();
    if (url === null)
      return;
    const parsed = URL.canParse(url) ? new URL(url) : null;
    if (parsed === null || parsed.protocol !== "https:" || !this.options.allowedHosts.includes(parsed.hostname))
      return this.options.log.warn(`Release page refused: ${url}`);
    await this.options.shell.openExternal(parsed.toString());
  }
}
