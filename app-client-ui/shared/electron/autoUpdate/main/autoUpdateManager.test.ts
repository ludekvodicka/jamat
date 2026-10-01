import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { expect } from "chai";
import type { UpdateCheckResult, UpdateInfo } from "electron-updater";
import type { AutoUpdateMode, DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import type { AutoUpdateLogHandler, AutoUpdateManagerOptions, AutoUpdateUpdater } from "./autoUpdate.types";
import { AutoUpdateManager } from "./autoUpdateManager";

type Listener = (...args: unknown[]) => void;

class FakeUpdater
{
  autoDownload = true;
  autoInstallOnAppQuit = false;
  readonly calls: string[] = [];
  readonly handlers = new Map<string, Listener[]>();
  checkResponse: () => Promise<UpdateCheckResult | null> = () => Promise.resolve(FakeUpdater.result(false));
  downloadResponse: () => Promise<string[]> = () => Promise.resolve([]);

  static result(isUpdateAvailable: boolean): UpdateCheckResult
  {
    const updateInfo = { version: "2.0.0", releaseName: "v2.0.0", releaseDate: "2026-10-01", releaseNotes: "<p>Notes</p>", files: [], path: "", sha512: "" } as UpdateInfo;
    return { isUpdateAvailable, updateInfo, versionInfo: updateInfo };
  }

  on(event: string, listener: Listener): this
  {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }

  removeListener(event: string, listener: Listener): this
  {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter(item => item !== listener));
    return this;
  }

  emit(event: string, ...args: unknown[]): void
  {
    for (const listener of this.handlers.get(event) ?? [])
      listener(...args);
  }

  installResponse: () => void = () => undefined;

  // Like electron-updater, a failing call emits "error" before its promise rejects.
  checkForUpdates(): Promise<UpdateCheckResult | null>
  {
    this.calls.push("check");
    return this.checkResponse().catch((error: unknown) => this.rejectWithEvent(error));
  }

  downloadUpdate(): Promise<string[]>
  {
    this.calls.push("download");
    return this.downloadResponse().catch((error: unknown) => this.rejectWithEvent(error));
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  {
    this.calls.push(`quitAndInstall:${String(isSilent)}:${String(isForceRunAfter)}`);
    this.installResponse();
  }

  private rejectWithEvent(error: unknown): never
  {
    this.emit("error", error);
    throw error;
  }
}

class RecordingLog implements AutoUpdateLogHandler
{
  readonly lines: string[] = [];
  info(message: string): void { this.lines.push(`info ${message}`); }
  warn(message: string): void { this.lines.push(`warn ${message}`); }
  error(message: string): void { this.lines.push(`error ${message}`); }
}

function createManager(mode: AutoUpdateMode, overrides: Partial<AutoUpdateManagerOptions> = {})
{
  const updater = new FakeUpdater();
  const log = new RecordingLog();
  const options: AutoUpdateManagerOptions = {
    resolution: { mode, reason: `${mode} reason` },
    running: "1.0.0",
    backgroundChecks: true,
    initialDelayMs: 45_000,
    intervalMs: 120 * 60_000,
    releasePageUrl: version => version ? `https://github.com/owner/repo/releases/tag/v${version}` : "https://github.com/owner/repo/releases",
    log,
    ...overrides,
  };
  const manager = new AutoUpdateManager(mode === "off" ? null : updater as unknown as AutoUpdateUpdater, options);
  const statuses: DtoAutoUpdateStatus[] = [];
  manager.subscribe(status => statuses.push(status));
  return { manager, updater, log, statuses };
}

function missingFeedError(): Error
{
  return Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\app\\resources\\app-update.yml'"), { code: "ENOENT" });
}

describe("electron/autoUpdate/main/AutoUpdateManager", () =>
{
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays off without touching the updater or creating timers", async () =>
  {
    const { manager, updater } = createManager("off");
    manager.start();
    expect(manager.getStatus().state).to.deep.equal({ kind: "off", reason: "off reason" });
    expect(vi.getTimerCount()).to.equal(0);
    await manager.check();
    expect(manager.getStatus().state.kind).to.equal("off");
    expect(updater.calls).to.deep.equal([]);
    manager.stop();
  });

  it("downloads a release found by the background check and reports progress", async () =>
  {
    const { manager, updater, statuses } = createManager("automatic");
    let finishDownload: (value: string[]) => void = () => undefined;
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    updater.downloadResponse = () => new Promise(resolve => { finishDownload = resolve; });
    manager.start();
    expect(updater.autoDownload).to.equal(false);
    expect(updater.autoInstallOnAppQuit).to.equal(true);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(updater.calls).to.deep.equal([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.calls).to.deep.equal(["check", "download"]);
    updater.emit("download-progress", { percent: 40, transferred: 4, total: 10, bytesPerSecond: 2, delta: 1 });
    const downloading = manager.getStatus().state;
    expect(downloading).to.include({ kind: "downloading", percent: 40, transferred: 4, total: 10, bytesPerSecond: 2 });
    finishDownload([]);
    await vi.advanceTimersByTimeAsync(0);
    const ready = manager.getStatus().state;
    expect(ready.kind).to.equal("ready");
    expect(ready.kind === "ready" && ready.release).to.deep.equal({ version: "2.0.0", name: "v2.0.0", date: "2026-10-01", notes: "Notes" });
    expect(statuses.map(status => status.state.kind)).to.deep.equal(["checking", "downloading", "downloading", "ready"]);
    manager.stop();
  });

  it("only reports an available release in notify mode", async () =>
  {
    const { manager, updater } = createManager("notify");
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    manager.start();
    expect(updater.autoInstallOnAppQuit).to.equal(false);
    await manager.check();
    expect(manager.getStatus().state.kind).to.equal("available");
    expect(updater.calls).to.deep.equal(["check"]);
    manager.stop();
  });

  it("reports current without an update and off for an inactive updater", async () =>
  {
    const { manager, updater } = createManager("automatic", { backgroundChecks: false });
    manager.start();
    await manager.check();
    const current = manager.getStatus().state;
    expect(current.kind).to.equal("current");
    updater.checkResponse = () => Promise.resolve(null);
    await manager.check();
    expect(manager.getStatus().state).to.deep.equal({ kind: "off", reason: "The updater is inactive in this build." });
    manager.stop();
  });

  it("checks again after the interval and creates no timer without background checks", async () =>
  {
    const { manager, updater } = createManager("automatic");
    manager.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(updater.calls).to.deep.equal(["check"]);
    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(updater.calls).to.deep.equal(["check", "check"]);
    manager.stop();

    const quiet = createManager("automatic", { backgroundChecks: false });
    quiet.manager.start();
    expect(vi.getTimerCount()).to.equal(0);
    quiet.manager.stop();
  });

  it("keeps the previous state after a failed background check and shows a failed manual check", async () =>
  {
    const { manager, updater, log } = createManager("automatic");
    manager.start();
    await manager.check();
    expect(manager.getStatus().state.kind).to.equal("current");
    updater.checkResponse = () => Promise.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(manager.getStatus().state.kind).to.equal("current");
    expect(log.lines).to.deep.equal(["info Updater error event: offline", "warn Background update check failed: offline"]);
    await manager.check();
    expect(manager.getStatus().state).to.deep.equal({ kind: "failed", message: "offline", release: null });
    manager.stop();
  });

  it("turns a missing app-update.yml into a permanent off state", async () =>
  {
    const { manager, updater } = createManager("automatic");
    updater.checkResponse = () => Promise.reject(missingFeedError());
    manager.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(manager.getStatus().state).to.deep.equal({ kind: "off", reason: "This build has no update feed." });
    expect(vi.getTimerCount()).to.equal(0);
    await manager.check();
    expect(updater.calls).to.deep.equal(["check"]);
    manager.stop();
  });

  it("ignores a check while busy and checks again after a failure", async () =>
  {
    const { manager, updater } = createManager("automatic", { backgroundChecks: false });
    let finishCheck: (value: UpdateCheckResult | null) => void = () => undefined;
    updater.checkResponse = () => new Promise(resolve => { finishCheck = resolve; });
    manager.start();
    const first = manager.check();
    await manager.check();
    expect(updater.calls).to.deep.equal(["check"]);
    finishCheck(FakeUpdater.result(false));
    await first;
    updater.checkResponse = () => Promise.reject(new Error("down"));
    await manager.check();
    expect(manager.getStatus().state.kind).to.equal("failed");
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(false));
    await manager.check();
    expect(manager.getStatus().state.kind).to.equal("current");
    expect(updater.calls).to.deep.equal(["check", "check", "check"]);
    manager.stop();
  });

  it("does not check while ready", async () =>
  {
    const { manager, updater } = createManager("automatic", { backgroundChecks: false });
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    manager.start();
    await manager.check();
    expect(manager.getStatus().state.kind).to.equal("ready");
    await manager.check();
    expect(updater.calls).to.deep.equal(["check", "download"]);
    manager.stop();
  });

  it("shows a failed download with its release", async () =>
  {
    const { manager, updater } = createManager("automatic", { backgroundChecks: false });
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    updater.downloadResponse = () => Promise.reject(new Error("disk full"));
    manager.start();
    await manager.check();
    const state = manager.getStatus().state;
    expect(state.kind).to.equal("failed");
    expect(state.kind === "failed" && state.message).to.equal("disk full");
    expect(state.kind === "failed" && state.release?.version).to.equal("2.0.0");
    manager.stop();
  });

  it("installs only when ready, once, after the paint delay", async () =>
  {
    const { manager, updater } = createManager("automatic", { backgroundChecks: false });
    manager.start();
    manager.install();
    expect(manager.getStatus().state.kind).to.equal("idle");
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    await manager.check();
    manager.install();
    expect(manager.getStatus().state.kind).to.equal("installing");
    manager.install();
    await vi.advanceTimersByTimeAsync(249);
    expect(updater.calls).to.not.include("quitAndInstall:false:true");
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.calls.filter(call => call.startsWith("quitAndInstall"))).to.deep.equal(["quitAndInstall:false:true"]);
    manager.stop();
  });

  it("shows a failed install when the updater reports an error after quitAndInstall", async () =>
  {
    const { manager, updater, log } = createManager("automatic", { backgroundChecks: false });
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    updater.installResponse = () => updater.emit("error", new Error("pkexec cancelled"));
    manager.start();
    await manager.check();
    manager.install();
    await vi.advanceTimersByTimeAsync(250);
    const state = manager.getStatus().state;
    expect(state.kind).to.equal("failed");
    expect(state.kind === "failed" && state.message).to.equal("pkexec cancelled");
    expect(state.kind === "failed" && state.release?.version).to.equal("2.0.0");
    expect(log.lines).to.deep.equal(["error Install failed: pkexec cancelled"]);
    await manager.check();
    expect(updater.calls.filter(call => call === "check")).to.have.length(2);
    manager.stop();
  });

  it("shows a failed install when quitAndInstall throws", async () =>
  {
    const { manager, updater } = createManager("automatic", { backgroundChecks: false });
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    updater.installResponse = () => { throw new Error("installer missing"); };
    manager.start();
    await manager.check();
    manager.install();
    await vi.advanceTimersByTimeAsync(250);
    expect(manager.getStatus().state).to.include({ kind: "failed", message: "installer missing" });
    manager.stop();
  });

  it("shows the failure of a background check that a manual check joined", async () =>
  {
    const { manager, updater } = createManager("automatic");
    let failCheck: (error: Error) => void = () => undefined;
    updater.checkResponse = () => new Promise((_resolve, reject) => { failCheck = reject; });
    manager.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(manager.getStatus().state.kind).to.equal("checking");
    await manager.check();
    failCheck(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getStatus().state).to.deep.equal({ kind: "failed", message: "offline", release: null });
    manager.stop();
  });

  it("starts in the off state before start() when the mode is off", () =>
  {
    const { manager } = createManager("off");
    expect(manager.getStatus().state).to.deep.equal({ kind: "off", reason: "off reason" });
  });

  it("clears timers and listeners on stop and only notes an error event outside an install", () =>
  {
    const { manager, updater, log } = createManager("automatic");
    manager.start();
    updater.emit("error", new Error("boom"));
    expect(log.lines).to.deep.equal(["info Updater error event: boom"]);
    expect(manager.getStatus().state.kind).to.equal("idle");
    manager.stop();
    expect(vi.getTimerCount()).to.equal(0);
    expect(updater.handlers.get("download-progress")).to.deep.equal([]);
    expect(updater.handlers.get("error")).to.deep.equal([]);
  });

  it("stops notifying after unsubscribe", async () =>
  {
    const { manager } = createManager("automatic", { backgroundChecks: false });
    const seen: string[] = [];
    const unsubscribe = manager.subscribe(status => seen.push(status.state.kind));
    manager.start();
    await manager.check();
    unsubscribe();
    await manager.check();
    expect(seen).to.deep.equal(["checking", "current"]);
    manager.stop();
  });

  it("composes the release page from the current release", async () =>
  {
    const { manager, updater } = createManager("automatic", { backgroundChecks: false });
    manager.start();
    expect(manager.releasePageUrl()).to.equal("https://github.com/owner/repo/releases");
    updater.checkResponse = () => Promise.resolve(FakeUpdater.result(true));
    await manager.check();
    expect(manager.releasePageUrl()).to.equal("https://github.com/owner/repo/releases/tag/v2.0.0");
    expect(manager.getStatus().releasePage).to.equal(true);
    expect(createManager("automatic", { releasePageUrl: null }).manager.releasePageUrl()).to.equal(null);
    manager.stop();
  });
});
