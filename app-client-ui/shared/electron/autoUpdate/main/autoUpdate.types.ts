import type { AppUpdater } from "electron-updater";
import type { AutoUpdateMode } from "../common/autoUpdate.dto";

export type AutoUpdateUpdater = Pick<AppUpdater,
  "checkForUpdates" | "downloadUpdate" | "quitAndInstall" | "on" | "removeListener" | "autoDownload" | "autoInstallOnAppQuit">;

/** Implemented by AutoUpdateLogConsole and by an app's own persistent log. */
export interface AutoUpdateLogHandler
{
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AutoUpdateResolution
{
  mode: AutoUpdateMode;
  reason: string;
}

export interface AutoUpdateRuntimeFacts
{
  packaged: boolean;
  platform: NodeJS.Platform;
  portable: boolean;
}

/** Builds the release page for a version, or the release list for null. */
export type AutoUpdateReleasePageUrl = (version: string | null) => string;

export interface AutoUpdateManagerOptions
{
  resolution: AutoUpdateResolution;
  running: string;
  backgroundChecks: boolean;
  initialDelayMs: number;
  intervalMs: number;
  releasePageUrl: AutoUpdateReleasePageUrl | null;
  log: AutoUpdateLogHandler;
}

export interface AutoUpdateMainOptions
{
  releasePageUrl: AutoUpdateReleasePageUrl | null;
  backgroundChecks?: boolean;
  intervalMinutes?: number;
  allowedHosts?: readonly string[];
  log?: AutoUpdateLogHandler;
}
