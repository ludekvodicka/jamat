import { describe, it } from "vitest";
import { expect } from "chai";
import { renderToStaticMarkup } from "react-dom/server";
import type { DtoAutoUpdateStatus } from "../autoUpdate/common/autoUpdate.dto";
import { AutoUpdateView } from "../autoUpdate/common/autoUpdateView";
import type { AutoUpdateController } from "../autoUpdate/renderer/useAutoUpdate";
import { AutoUpdateIndicator } from "./autoUpdateIndicator";

function controller(status: DtoAutoUpdateStatus | null): AutoUpdateController
{
  return { status, view: status && AutoUpdateView.describe(status), check: () => undefined, install: () => undefined, openReleasePage: () => undefined };
}

const release = { version: "2.0.0", name: null, date: null, notes: null };

describe("electron/autoUpdateWidgets/AutoUpdateIndicator", () =>
{
  it("renders the tone class and the label", () =>
  {
    const html = renderToStaticMarkup(<AutoUpdateIndicator update={controller({ running: "1.0.0", mode: "off", releasePage: false, state: { kind: "off", reason: "Development run" } })} onOpen={() => undefined} className="status-item" />);
    expect(html).to.contain("auto-update-indicator auto-update-tone-muted status-item");
    expect(html).to.contain("Updates off");
    expect(html).to.contain("title=\"Development run\"");
    expect(html).to.not.contain("Restart and install");
  });

  it("shows Restart and install only when ready", () =>
  {
    const html = renderToStaticMarkup(<AutoUpdateIndicator update={controller({ running: "1.0.0", mode: "automatic", releasePage: false, state: { kind: "ready", release } })} onOpen={() => undefined} />);
    expect(html).to.contain("auto-update-tone-ready");
    expect(html).to.contain("Restart and install");
  });

  it("renders nothing before the first status", () =>
  {
    expect(renderToStaticMarkup(<AutoUpdateIndicator update={controller(null)} onOpen={() => undefined} />)).to.equal("");
  });

  it("renders only prefixed class names", () =>
  {
    const html = renderToStaticMarkup(<AutoUpdateIndicator update={controller({ running: "1.0.0", mode: "automatic", releasePage: true, state: { kind: "ready", release } })} onOpen={() => undefined} />);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(match => (match[1] ?? "").split(" "));
    expect(classes).to.not.be.empty;
    expect(classes.filter(name => !name.startsWith("auto-update-"))).to.deep.equal([]);
  });
});
