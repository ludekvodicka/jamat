import { describe, it } from "vitest";
import { expect } from "chai";
import type { AutoUpdateState, DtoAutoUpdateRelease, DtoAutoUpdateStatus } from "./autoUpdate.dto";
import { AutoUpdateView } from "./autoUpdateView";

const release: DtoAutoUpdateRelease = { version: "2.0.0", name: "v2.0.0", date: "2026-10-01T10:00:00.000Z", notes: "Fixes" };

function status(state: AutoUpdateState, releasePage = true): DtoAutoUpdateStatus
{
  return { running: "1.0.0", mode: "automatic", releasePage, state };
}

describe("electron/autoUpdate/common/AutoUpdateView", () =>
{
  it("describes off with the reason and the release link", () =>
  {
    const view = AutoUpdateView.describe(status({ kind: "off", reason: "Development run" }));
    expect(view).to.deep.equal({ text: "Updates off", detail: "Development run", tone: "muted", actions: ["openRelease"], release: null });
  });

  it("offers a check in idle and current", () =>
  {
    expect(AutoUpdateView.describe(status({ kind: "idle" })).actions).to.deep.equal(["check"]);
    const current = AutoUpdateView.describe(status({ kind: "current", checkedAt: 1 }));
    expect(current.text).to.equal("Up to date");
    expect(current.detail).to.equal("Version 1.0.0");
    expect(current.actions).to.deep.equal(["check"]);
  });

  it("offers no action while checking or installing", () =>
  {
    expect(AutoUpdateView.describe(status({ kind: "checking" })).actions).to.deep.equal([]);
    const installing = AutoUpdateView.describe(status({ kind: "installing", release }));
    expect(installing.actions).to.deep.equal([]);
    expect(installing.tone).to.equal("working");
  });

  it("describes an available release with link and check", () =>
  {
    const view = AutoUpdateView.describe(status({ kind: "available", release }));
    expect(view.text).to.equal("Version 2.0.0 available");
    expect(view.tone).to.equal("attention");
    expect(view.actions).to.deep.equal(["openRelease", "check"]);
    expect(view.release).to.equal(release);
  });

  it("rounds the download percent", () =>
  {
    const view = AutoUpdateView.describe(status({ kind: "downloading", release, percent: 41.6, transferred: 4, total: 10, bytesPerSecond: 1 }));
    expect(view.text).to.equal("Downloading 2.0.0 (42%)");
    expect(view.actions).to.deep.equal([]);
  });

  it("offers install first when ready", () =>
  {
    const view = AutoUpdateView.describe(status({ kind: "ready", release }));
    expect(view.tone).to.equal("ready");
    expect(view.actions).to.deep.equal(["install", "openRelease"]);
  });

  it("describes a failure with the message and a retry", () =>
  {
    const view = AutoUpdateView.describe(status({ kind: "failed", message: "Network down", release: null }));
    expect(view.detail).to.equal("Network down");
    expect(view.tone).to.equal("failed");
    expect(view.actions).to.deep.equal(["check", "openRelease"]);
  });

  it("drops the release link without a release page", () =>
  {
    expect(AutoUpdateView.describe(status({ kind: "off", reason: "x" }, false)).actions).to.deep.equal([]);
    expect(AutoUpdateView.describe(status({ kind: "ready", release }, false)).actions).to.deep.equal(["install"]);
  });

  it("throws on an unknown state", () =>
  {
    const unknown = { kind: "paused" } as unknown as AutoUpdateState;
    expect(() => AutoUpdateView.describe(status(unknown))).to.throw("Unknown update state");
  });
});
