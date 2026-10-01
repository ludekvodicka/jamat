import { describe, it } from "vitest";
import { expect } from "chai";
import type { UpdateInfo } from "electron-updater";
import { AutoUpdateReleaseNotes } from "./autoUpdateReleaseNotes";

describe("electron/autoUpdate/main/AutoUpdateReleaseNotes", () =>
{
  it("turns paragraphs, list items, breaks and entities into text", () =>
  {
    const html = "<h2>What&#39;s new</h2><p>Faster &amp; smaller</p><ul><li>One</li><li>Two &lt;b&gt;</li></ul><p>Line<br/>break</p>";
    expect(AutoUpdateReleaseNotes.toText(html)).to.equal("What's new\nFaster & smaller\n\n- One\n- Two <b>\nLine\nbreak");
  });

  it("drops tags and script content", () =>
  {
    const text = AutoUpdateReleaseNotes.toText("<p>Safe</p><script>alert(1)</script><img src=x onerror=alert(2)>");
    expect(text).to.equal("Safe");
  });

  it("joins the array form per version", () =>
  {
    const text = AutoUpdateReleaseNotes.toText([{ version: "2.0.0", note: "<p>New</p>" }, { version: "1.9.0", note: null }]);
    expect(text).to.equal("2.0.0\nNew\n\n1.9.0");
  });

  it("returns null for missing, empty and blank notes", () =>
  {
    expect(AutoUpdateReleaseNotes.toText(null)).to.equal(null);
    expect(AutoUpdateReleaseNotes.toText(undefined)).to.equal(null);
    expect(AutoUpdateReleaseNotes.toText("")).to.equal(null);
    expect(AutoUpdateReleaseNotes.toText("  <p> </p> ")).to.equal(null);
  });

  it("builds the release from the update info", () =>
  {
    const info = { version: "2.0.0", releaseName: "v2.0.0", releaseDate: "2026-10-01T10:00:00.000Z", releaseNotes: "<p>Notes</p>", files: [], path: "", sha512: "" } as UpdateInfo;
    expect(AutoUpdateReleaseNotes.toRelease(info)).to.deep.equal({ version: "2.0.0", name: "v2.0.0", date: "2026-10-01T10:00:00.000Z", notes: "Notes" });
  });

  it("fills null for a release without name or date", () =>
  {
    const info = { version: "2.0.0", releaseDate: "", files: [], path: "", sha512: "" } as UpdateInfo;
    expect(AutoUpdateReleaseNotes.toRelease(info)).to.deep.equal({ version: "2.0.0", name: null, date: null, notes: null });
  });
});
