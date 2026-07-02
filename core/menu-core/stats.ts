import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { Category, FolderStats, StatsMap } from "../types.js";
import { resolveUserDataDir } from "../userdata-path.js";

export function getStatsPath(configDir?: string): string {
  // Lives in the portable config-dir so the Electron app + the CLI menu + the standalone agent/stats
  // all read one file. `configDir` is the resolved --config-dir; absent → legacy userData fallback.
  return join(configDir ?? resolveUserDataDir(), "usage-stats.json");
}

export function statsKey(cat: Category, folder: string): string {
  return `${cat.label}:${folder}`;
}

export function loadStats(statsFile: string): StatsMap {
  try {
    return JSON.parse(readFileSync(statsFile, "utf-8"));
  } catch {
    return {};
  }
}

export function saveStats(statsFile: string, stats: StatsMap) {
  mkdirSync(dirname(statsFile), { recursive: true });
  writeFileSync(statsFile, JSON.stringify(stats, null, 2));
}

export function recordUsage(statsFile: string, stats: StatsMap, cat: Category, folder: string) {
  const key = statsKey(cat, folder);
  const entry = stats[key] || { count: 0, lastUsed: "" };
  entry.count++;
  entry.lastUsed = new Date().toISOString();
  stats[key] = entry;
  saveStats(statsFile, stats);
}
