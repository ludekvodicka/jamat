import type { AutoUpdateLogHandler } from "./autoUpdate.types";

export class AutoUpdateLogConsole implements AutoUpdateLogHandler
{
  info(message: string): void
  {
    console.info(`[updater] ${message}`);
  }

  warn(message: string): void
  {
    console.warn(`[updater] ${message}`);
  }

  error(message: string): void
  {
    console.error(`[updater] ${message}`);
  }
}
