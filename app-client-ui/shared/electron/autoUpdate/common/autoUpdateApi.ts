import type { DtoAutoUpdateStatus } from "./autoUpdate.dto";

export interface AutoUpdateApi
{
  status(): Promise<DtoAutoUpdateStatus>;
  check(): Promise<void>;
  install(): Promise<void>;
  openReleasePage(): Promise<void>;
  onChanged(listener: (status: DtoAutoUpdateStatus) => void): () => void;
}

export class AutoUpdateConst
{
  static readonly channelStatus = "autoUpdate:status";
  static readonly channelCheck = "autoUpdate:check";
  static readonly channelInstall = "autoUpdate:install";
  static readonly channelOpenReleasePage = "autoUpdate:openReleasePage";
  static readonly channelChanged = "autoUpdate:changed";
  static readonly initialDelayMs = 45_000;
  static readonly intervalMinutes = 120;
  static readonly installPaintMs = 250;
  static readonly allowedHosts: readonly string[] = ["github.com"];
}
