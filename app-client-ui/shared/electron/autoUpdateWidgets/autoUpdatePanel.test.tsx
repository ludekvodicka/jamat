import { describe, it } from "vitest";
import { expect } from "chai";
import { renderToStaticMarkup } from "react-dom/server";
import type { DtoAutoUpdateStatus } from "../autoUpdate/common/autoUpdate.dto";
import { AutoUpdateView } from "../autoUpdate/common/autoUpdateView";
import type { AutoUpdateController } from "../autoUpdate/renderer/useAutoUpdate";
import { AutoUpdatePanel } from "./autoUpdatePanel";

function controller(status: DtoAutoUpdateStatus): AutoUpdateController
{
  return { status, view: AutoUpdateView.describe(status), check: () => undefined, install: () => undefined, openReleasePage: () => undefined };
}

const release = { version: "2.0.0", name: "Version 2", date: "2026-10-01T10:00:00.000Z", notes: "Fixed <b>bold</b> text" };

describe("electron/autoUpdateWidgets/AutoUpdatePanel", () =>
{
  it("renders nothing while closed", () =>
  {
    const update = controller({ running: "1.0.0", mode: "automatic", releasePage: true, state: { kind: "ready", release } });
    expect(renderToStaticMarkup(<AutoUpdatePanel update={update} open={false} onClose={() => undefined} />)).to.equal("");
  });

  it("shows the release, escaped notes and the ready actions", () =>
  {
    const update = controller({ running: "1.0.0", mode: "automatic", releasePage: true, state: { kind: "ready", release } });
    const html = renderToStaticMarkup(<AutoUpdatePanel update={update} open={true} onClose={() => undefined} />);
    expect(html).to.contain("Version 2.0.0 ready");
    expect(html).to.contain("Version 2 (2026-10-01)");
    expect(html).to.contain("Fixed &lt;b&gt;bold&lt;/b&gt; text");
    expect(html).to.contain("Restart and install");
    expect(html).to.contain("View on GitHub");
    expect(html).to.not.contain("Check now");
  });

  it("offers Check now without a release link when there is no release page", () =>
  {
    const update = controller({ running: "1.0.0", mode: "automatic", releasePage: false, state: { kind: "current", checkedAt: 1 } });
    const html = renderToStaticMarkup(<AutoUpdatePanel update={update} open={true} onClose={() => undefined} />);
    expect(html).to.contain("Check now");
    expect(html).to.not.contain("View on GitHub");
    expect(html).to.not.contain("auto-update-notes");
    expect(html).to.contain("Close");
  });
});
