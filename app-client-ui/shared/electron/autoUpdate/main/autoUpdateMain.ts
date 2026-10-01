import { app, BrowserWindow, ipcMain, shell } from "electron";
// Default import: electron-updater is CommonJS and the main process is an ES module.
import electronUpdater from "electron-updater";
import type { DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import { AutoUpdateConst } from "../common/autoUpdateApi";
import type { AutoUpdateMainOptions } from "./autoUpdate.types";
import { AutoUpdateIpc } from "./autoUpdateIpc";
import { AutoUpdateLogConsole } from "./autoUpdateLogConsole";
import { AutoUpdateManager } from "./autoUpdateManager";
import { AutoUpdateRuntime } from "./autoUpdateRuntime";

export class AutoUpdateMain
{
  private readonly manager: AutoUpdateManager;
  private readonly ipc: AutoUpdateIpc;

  constructor(options: AutoUpdateMainOptions)
  {
    const resolution = AutoUpdateRuntime.resolve({
      packaged: app.isPackaged,
      platform: process.platform,
      portable: process.env.PORTABLE_EXECUTABLE_DIR !== undefined,
    });
    const log = options.log ?? new AutoUpdateLogConsole();
    // The autoUpdater getter builds the platform updater on first access, so an off build never touches it.
    const updater = resolution.mode === "off" ? null : electronUpdater.autoUpdater;
    // A bundler that resolves the default import to the module's own "default" leaves autoUpdater undefined.
    if (resolution.mode !== "off" && !updater)
      throw new Error("electron-updater has no autoUpdater export: bundle electron-updater as an external CommonJS module");
    this.manager = new AutoUpdateManager(updater, {
      resolution,
      running: app.getVersion(),
      backgroundChecks: options.backgroundChecks ?? true,
      initialDelayMs: AutoUpdateConst.initialDelayMs,
      intervalMs: (options.intervalMinutes ?? AutoUpdateConst.intervalMinutes) * 60_000,
      releasePageUrl: options.releasePageUrl,
      log,
    });
    this.ipc = new AutoUpdateIpc(this.manager, {
      ipcMain,
      shell,
      log,
      windows: () => BrowserWindow.getAllWindows(),
      allowedHosts: options.allowedHosts ?? AutoUpdateConst.allowedHosts,
    });
  }

  start(): void
  {
    this.ipc.register();
    this.manager.start();
  }

  stop(): void
  {
    this.manager.stop();
    this.ipc.unregister();
  }

  check(): Promise<void>
  {
    return this.manager.check();
  }

  install(): void
  {
    this.manager.install();
  }

  getStatus(): DtoAutoUpdateStatus
  {
    return this.manager.getStatus();
  }

  subscribe(listener: (status: DtoAutoUpdateStatus) => void): () => void
  {
    return this.manager.subscribe(listener);
  }
}
