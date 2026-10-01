export type AutoUpdateMode = "automatic" | "notify" | "off";

export interface DtoAutoUpdateRelease
{
  version: string;
  name: string | null;
  date: string | null;
  /** Plain text, converted from the release HTML in the main process. */
  notes: string | null;
}

export type AutoUpdateState =
  | { kind: "off"; reason: string }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; checkedAt: number }
  | { kind: "available"; release: DtoAutoUpdateRelease }
  | { kind: "downloading"; release: DtoAutoUpdateRelease; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: "ready"; release: DtoAutoUpdateRelease }
  | { kind: "installing"; release: DtoAutoUpdateRelease }
  | { kind: "failed"; message: string; release: DtoAutoUpdateRelease | null };

export interface DtoAutoUpdateStatus
{
  running: string;
  mode: AutoUpdateMode;
  /** The URL stays in the main process; the renderer only learns that a release page exists. */
  releasePage: boolean;
  state: AutoUpdateState;
}
