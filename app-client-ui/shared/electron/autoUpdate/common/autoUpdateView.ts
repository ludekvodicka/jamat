import type { DtoAutoUpdateRelease, DtoAutoUpdateStatus } from "./autoUpdate.dto";

export type AutoUpdateTone = "muted" | "working" | "attention" | "ready" | "failed";
export type AutoUpdateAction = "check" | "install" | "openRelease";

export interface AutoUpdateViewModel
{
  text: string;
  detail: string | null;
  tone: AutoUpdateTone;
  actions: AutoUpdateAction[];
  release: DtoAutoUpdateRelease | null;
}

export class AutoUpdateView
{
  static describe(status: DtoAutoUpdateStatus): AutoUpdateViewModel
  {
    const state = status.state;
    const link: AutoUpdateAction[] = status.releasePage ? ["openRelease"] : [];
    if (state.kind === "off")
      return { text: "Updates off", detail: state.reason, tone: "muted", actions: link, release: null };
    else if (state.kind === "idle")
      return { text: `Version ${status.running}`, detail: null, tone: "muted", actions: ["check"], release: null };
    else if (state.kind === "checking")
      return { text: "Checking for updates", detail: null, tone: "working", actions: [], release: null };
    else if (state.kind === "current")
      return { text: "Up to date", detail: `Version ${status.running}`, tone: "muted", actions: ["check"], release: null };
    else if (state.kind === "available")
      return { text: `Version ${state.release.version} available`, detail: null, tone: "attention", actions: [...link, "check"], release: state.release };
    else if (state.kind === "downloading")
      return { text: `Downloading ${state.release.version} (${Math.round(state.percent)}%)`, detail: null, tone: "working", actions: [], release: state.release };
    else if (state.kind === "ready")
      return { text: `Version ${state.release.version} ready`, detail: "Installs on restart or on the next quit.", tone: "ready", actions: ["install", ...link], release: state.release };
    else if (state.kind === "installing")
      return { text: "Restarting to install", detail: null, tone: "working", actions: [], release: state.release };
    else if (state.kind === "failed")
      return { text: "Update failed", detail: state.message, tone: "failed", actions: ["check", ...link], release: state.release };
    else
      throw new Error(`Unknown update state: ${JSON.stringify(state)}`);
  }
}
