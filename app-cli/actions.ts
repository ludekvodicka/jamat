import {
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import * as readline from "readline";

import type { AgentId, Category, MenuSelection, StatsMap } from "../core/types.js";
import { loadProjectConfig } from "../core/menu-core/projects.js";
import { recordUsage } from "../core/menu-core/stats.js";

type ActionType = NonNullable<MenuSelection['action']>;

export interface ActionConfig {
  statsFile: string;
  selectionFile: string;
}

export function promptFolderName(): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(
      "\x1b[1m  Create new project\x1b[0m\n\n  Folder name: "
    );

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.on("line", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptIsolated(): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write("  Isolated (Docker)? (y/n) ");

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    const onKey = (_str: string, key: readline.Key) => {
      process.stdin.removeListener("keypress", onKey);
      if (key?.name === "y") {
        process.stdout.write("yes\n");
        resolve(true);
      } else {
        process.stdout.write("no\n");
        resolve(false);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

export function confirmArchive(folderName: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(
      `\n  \x1b[33mArchive "\x1b[1m${folderName}\x1b[0m\x1b[33m" to Archived/? (y/n) \x1b[0m`
    );
    const onKey = (_str: string, key: readline.Key) => {
      if (key?.name === "y") {
        process.stdin.removeListener("keypress", onKey);
        resolve(true);
      } else if (key?.name === "n" || key?.name === "escape") {
        process.stdin.removeListener("keypress", onKey);
        resolve(false);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

export function archiveFolder(cat: Category, folderName: string) {
  const archiveDir = join(cat.path, "Archived");
  const destPath = join(archiveDir, folderName);
  mkdirSync(dirname(destPath), { recursive: true });
  renameSync(join(cat.path, folderName), destPath);
}

export function confirmDelete(folderName: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(
      `\n  \x1b[31mPermanently DELETE "\x1b[1m${folderName}\x1b[0m\x1b[31m"? (y/n) \x1b[0m`
    );
    const onKey = (_str: string, key: readline.Key) => {
      if (key?.name === "y") {
        process.stdin.removeListener("keypress", onKey);
        resolve(true);
      } else if (key?.name === "n" || key?.name === "escape") {
        process.stdin.removeListener("keypress", onKey);
        resolve(false);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

export function deleteFolder(cat: Category, folderName: string) {
  rmSync(join(cat.path, folderName), { recursive: true, force: true });
}

export function launchInFolder(
  cfg: ActionConfig,
  cat: Category,
  folderName: string,
  cmd: string,
  stats: StatsMap,
  antiFlicker: boolean,
  agent: AgentId
) {
  recordUsage(cfg.statsFile, stats, cat, folderName);
  const targetDir = join(cat.path, folderName);
  const projConfig = loadProjectConfig(targetDir);
  writeFileSync(cfg.selectionFile, JSON.stringify({
    dir: targetDir, cmd, folderName, isolated: projConfig.isolated, antiFlicker,
    agent,
  }));
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
}

export function dispatchAction(cfg: ActionConfig, action: ActionType, extra?: Record<string, unknown>) {
  writeFileSync(cfg.selectionFile, JSON.stringify({ action, ...extra }));
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
}

export function launchSessionResume(
  cfg: ActionConfig,
  cat: Category,
  folderName: string,
  sessionId: string,
  active: boolean,
  stats: StatsMap,
  antiFlicker: boolean,
  agent: AgentId
) {
  recordUsage(cfg.statsFile, stats, cat, folderName);
  const targetDir = join(cat.path, folderName);
  const projConfig = loadProjectConfig(targetDir);
  const cmd = active ? "resume-fork" : "resume";
  writeFileSync(cfg.selectionFile, JSON.stringify({
    dir: targetDir, cmd, folderName, isolated: projConfig.isolated, sessionId, antiFlicker,
    agent,
  }));
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
}
