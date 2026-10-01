import { describe, it } from "vitest";
import { expect } from "chai";
import { AutoUpdateRuntime } from "./autoUpdateRuntime";

describe("electron/autoUpdate/main/AutoUpdateRuntime", () =>
{
  it("is off in a development run on every platform", () =>
  {
    expect(AutoUpdateRuntime.resolve({ packaged: false, platform: "win32", portable: false }).mode).to.equal("off");
    expect(AutoUpdateRuntime.resolve({ packaged: false, platform: "linux", portable: false }).mode).to.equal("off");
  });

  it("only notifies in a Windows portable build", () =>
  {
    expect(AutoUpdateRuntime.resolve({ packaged: true, platform: "win32", portable: true }).mode).to.equal("notify");
  });

  it("updates an installed Windows build automatically", () =>
  {
    expect(AutoUpdateRuntime.resolve({ packaged: true, platform: "win32", portable: false }).mode).to.equal("automatic");
  });

  it("only notifies on unsigned macOS", () =>
  {
    const resolution = AutoUpdateRuntime.resolve({ packaged: true, platform: "darwin", portable: false });
    expect(resolution.mode).to.equal("notify");
    expect(resolution.reason).to.contain("macOS");
  });

  it("updates a packaged Linux build automatically", () =>
  {
    expect(AutoUpdateRuntime.resolve({ packaged: true, platform: "linux", portable: false }).mode).to.equal("automatic");
  });

  it("throws on an unsupported platform", () =>
  {
    expect(() => AutoUpdateRuntime.resolve({ packaged: true, platform: "aix", portable: false })).to.throw("Unsupported update platform");
  });
});
