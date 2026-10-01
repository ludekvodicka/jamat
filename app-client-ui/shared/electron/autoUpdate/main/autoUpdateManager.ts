import type { ProgressInfo, UpdateCheckResult } from "electron-updater";
import type { AutoUpdateState, DtoAutoUpdateRelease, DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import { AutoUpdateConst } from "../common/autoUpdateApi";
import type { AutoUpdateManagerOptions, AutoUpdateUpdater } from "./autoUpdate.types";
import { AutoUpdateReleaseNotes } from "./autoUpdateReleaseNotes";

type AutoUpdateTrigger = "background" | "manual";

export class AutoUpdateManager
{
  private readonly updater: AutoUpdateUpdater | null;
  private readonly options: AutoUpdateManagerOptions;
  private readonly listeners: Set<(status: DtoAutoUpdateStatus) => void>;
  private readonly onProgress: (info: ProgressInfo) => void;
  private readonly onError: (error: Error) => void;
  private status: DtoAutoUpdateStatus;
  private checkTrigger: AutoUpdateTrigger;
  private listening: boolean;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;

  /** The updater is null when the runtime resolved to off: an off build never touches electron-updater. */
  constructor(updater: AutoUpdateUpdater | null, options: AutoUpdateManagerOptions)
  {
    this.updater = updater;
    this.options = options;
    this.listeners = new Set();
    const initial: AutoUpdateState = options.resolution.mode === "off" ? { kind: "off", reason: options.resolution.reason } : { kind: "idle" };
    this.status = { running: options.running, mode: options.resolution.mode, releasePage: options.releasePageUrl !== null, state: initial };
    this.checkTrigger = "background";
    this.listening = false;
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
    this.onProgress = info => this.progress(info);
    this.onError = error => this.updaterError(error);
  }

  start(): void
  {
    if (this.options.resolution.mode === "off")
      return this.setState({ kind: "off", reason: this.options.resolution.reason });
    const updater = this.requireUpdater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = this.options.resolution.mode === "automatic";
    updater.on("download-progress", this.onProgress);
    // An EventEmitter "error" event without a listener throws in the main process.
    updater.on("error", this.onError);
    this.listening = true;
    if (!this.options.backgroundChecks)
      return;
    this.initialTimer = setTimeout(() =>
    {
      this.initialTimer = undefined;
      void this.runCheck("background");
      this.intervalTimer = setInterval(() => void this.runCheck("background"), this.options.intervalMs);
    }, this.options.initialDelayMs);
  }

  stop(): void
  {
    this.stopTimers();
    if (!this.listening)
      return;
    const updater = this.requireUpdater();
    updater.removeListener("download-progress", this.onProgress);
    updater.removeListener("error", this.onError);
    this.listening = false;
  }

  getStatus(): DtoAutoUpdateStatus
  {
    return this.status;
  }

  subscribe(listener: (status: DtoAutoUpdateStatus) => void): () => void
  {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  check(): Promise<void>
  {
    return this.runCheck("manual");
  }

  install(): void
  {
    const state = this.status.state;
    if (state.kind !== "ready")
      return;
    this.setState({ kind: "installing", release: state.release });
    // A short delay lets the renderer paint "Restarting to install" before the windows close.
    setTimeout(() => this.quitAndInstall(), AutoUpdateConst.installPaintMs);
  }

  releasePageUrl(): string | null
  {
    const state = this.status.state;
    const version = "release" in state && state.release ? state.release.version : null;
    return this.options.releasePageUrl ? this.options.releasePageUrl(version) : null;
  }

  private async runCheck(trigger: AutoUpdateTrigger): Promise<void>
  {
    const previous = this.status.state;
    // A manual check during a background check takes it over, so its failure is shown instead of hidden.
    if (previous.kind === "checking" && trigger === "manual")
      this.checkTrigger = "manual";
    if (previous.kind === "off" || previous.kind === "checking" || previous.kind === "downloading"
      || previous.kind === "ready" || previous.kind === "installing")
      return;
    this.checkTrigger = trigger;
    this.setState({ kind: "checking" });
    let result: UpdateCheckResult | null;
    try
    {
      result = await this.requireUpdater().checkForUpdates();
    }
    catch (error)
    {
      return this.checkFailed(this.checkTrigger, previous, error);
    }
    if (result === null)
      return this.setState({ kind: "off", reason: "The updater is inactive in this build." });
    if (!result.isUpdateAvailable)
      return this.setState({ kind: "current", checkedAt: Date.now() });
    const release = AutoUpdateReleaseNotes.toRelease(result.updateInfo);
    const mode = this.options.resolution.mode;
    if (mode === "automatic")
      return await this.download(release);
    else if (mode === "notify")
      return this.setState({ kind: "available", release });
    else
      throw new Error(`Update found in mode ${mode}`);
  }

  private checkFailed(trigger: AutoUpdateTrigger, previous: AutoUpdateState, error: unknown): void
  {
    if (AutoUpdateManager.isMissingFeed(error))
    {
      this.stopTimers();
      return this.setState({ kind: "off", reason: "This build has no update feed." });
    }
    if (trigger === "background")
    {
      this.options.log.warn(`Background update check failed: ${AutoUpdateManager.messageOf(error)}`);
      // Being offline is not an update failure: the indicator keeps what it showed before.
      return this.setState(previous);
    }
    else if (trigger === "manual")
      return this.setState({ kind: "failed", message: AutoUpdateManager.messageOf(error), release: null });
    else
      throw new Error(`Unknown check trigger: ${String(trigger)}`);
  }

  private async download(release: DtoAutoUpdateRelease): Promise<void>
  {
    this.setState({ kind: "downloading", release, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    try
    {
      await this.requireUpdater().downloadUpdate();
    }
    catch (error)
    {
      return this.setState({ kind: "failed", message: AutoUpdateManager.messageOf(error), release });
    }
    this.setState({ kind: "ready", release });
  }

  // A failing check or download also rejects its promise, which owns that state change, so the event is only
  // noted. quitAndInstall has no promise: a failed install (a refused elevation on Linux) arrives only here.
  private updaterError(error: Error): void
  {
    const state = this.status.state;
    if (state.kind === "installing")
    {
      this.options.log.error(`Install failed: ${AutoUpdateManager.messageOf(error)}`);
      return this.setState({ kind: "failed", message: AutoUpdateManager.messageOf(error), release: state.release });
    }
    this.options.log.info(`Updater error event: ${AutoUpdateManager.messageOf(error)}`);
  }

  private quitAndInstall(): void
  {
    try
    {
      this.requireUpdater().quitAndInstall(false, true);
    }
    catch (error)
    {
      this.updaterError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private progress(info: ProgressInfo): void
  {
    const state = this.status.state;
    if (state.kind !== "downloading")
      return;
    this.setState({ kind: "downloading", release: state.release, percent: info.percent, transferred: info.transferred, total: info.total, bytesPerSecond: info.bytesPerSecond });
  }

  private setState(state: AutoUpdateState): void
  {
    this.status = { ...this.status, state };
    for (const listener of this.listeners)
      listener(this.status);
  }

  private stopTimers(): void
  {
    clearTimeout(this.initialTimer);
    clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
  }

  private requireUpdater(): AutoUpdateUpdater
  {
    if (this.updater === null)
      throw new Error("The updater is missing although the update mode is not off");
    return this.updater;
  }

  /** electron-updater reports a build without app-update.yml as ENOENT on that file. */
  private static isMissingFeed(error: unknown): boolean
  {
    return error instanceof Error && "code" in error && error.code === "ENOENT" && error.message.includes("app-update.yml");
  }

  private static messageOf(error: unknown): string
  {
    return error instanceof Error ? error.message : String(error);
  }
}
