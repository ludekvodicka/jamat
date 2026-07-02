import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Category } from "../types.js";
import { statsKey } from "./stats.js";
import type { StatsMap } from "../types.js";
import {
  matchesVirtualPrefix,
  stripVirtualPrefix,
  buildDisplayEntries,
  sortProjectEntries,
  type SortMode,
  type DisplayEntry,
  type ProjectEntry,
} from "./pure.js";
import { getAgent } from "../agents/index.js";

export { matchesVirtualPrefix, stripVirtualPrefix, type SortMode };

export interface ProjectConfig {
  isolated: boolean;
}

const projectConfigCache = new Map<string, ProjectConfig>();

export function invalidateProjectConfigCache() {
  projectConfigCache.clear();
}

export function loadProjectConfig(projectDir: string): ProjectConfig {
  const cached = projectConfigCache.get(projectDir);
  if (cached) return cached;
  let config: ProjectConfig;
  try {
    const raw = JSON.parse(readFileSync(join(projectDir, ".jamat.json"), "utf-8"));
    config = { isolated: raw.isolated ?? false };
  } catch {
    config = { isolated: false };
  }
  projectConfigCache.set(projectDir, config);
  return config;
}

export function getFolders(cat: Category, stats: StatsMap, sortMode: SortMode = "usage"): string[] {
  try {
    const topDirs = readdirSync(cat.path).filter((name) => {
      // "Archived" is the universal archive target (every category now supports
      // archiving), so it is always hidden from the project list.
      if (name.startsWith(".") || name === "Archived" || cat.hiddenFolders.has(name)) return false;
      try {
        return statSync(join(cat.path, name)).isDirectory();
      } catch {
        return false;
      }
    });

    const allNames: string[] = [];
    for (const name of topDirs) {
      if (cat.flattenFolders.has(name)) {
        try {
          const children = readdirSync(join(cat.path, name)).filter((child) => {
            if (child.startsWith(".")) return false;
            try {
              return statSync(join(cat.path, name, child)).isDirectory();
            } catch {
              return false;
            }
          });
          for (const child of children) {
            allNames.push(`${name}/${child}`);
          }
        } catch {}
      } else {
        allNames.push(name);
      }
    }

    const entries: ProjectEntry[] = allNames.map((name) => {
      const entry = stats[statsKey(cat, name)];
      return { name, usageCount: entry?.count || 0, lastUsed: entry?.lastUsed || null };
    });
    return sortProjectEntries(entries, sortMode).map((e) => e.name);
  } catch {
    return [];
  }
}

export function buildMenuEntries(
  cat: Category,
  folderNames: string[],
  currentVirtualPrefix: string | null,
  virtualFoldersEnabled: boolean = true
): DisplayEntry[] {
  const entries = buildDisplayEntries(folderNames, cat.virtualFolders, currentVirtualPrefix, virtualFoldersEnabled);
  for (const entry of entries) {
    if (entry.kind === "folder" && entry.name.includes("/")) {
      entry.displayName = entry.displayName.replace(/\//g, "-");
    }
  }
  return entries;
}

function findCurrentPrefix(name: string, virtualFolders: { prefix: string; title: string }[]): string {
  for (const vf of virtualFolders) {
    if (matchesVirtualPrefix(name, vf.prefix)) return vf.prefix;
  }
  return "";
}

function stripCurrentPrefix(name: string, virtualFolders: { prefix: string; title: string }[]): string {
  const prefix = findCurrentPrefix(name, virtualFolders);
  return prefix ? stripVirtualPrefix(name, prefix) : name;
}

function applyPrefix(baseName: string, targetPrefix: string): string {
  if (!targetPrefix) return baseName;
  if (!baseName) return targetPrefix;
  const lastChar = targetPrefix[targetPrefix.length - 1];
  if (lastChar === "-" || lastChar === "_") return targetPrefix + baseName;
  return targetPrefix + baseName[0].toUpperCase() + baseName.slice(1);
}

export interface MoveResult {
  oldName: string;
  newName: string;
  claudeRenamed: boolean;
}

function updateSessionPaths(claudeDir: string, oldProjectPath: string, newProjectPath: string) {
  try {
    const files = readdirSync(claudeDir).filter((f) => f.endsWith(".jsonl"));
    const oldBack = oldProjectPath.replace(/\//g, "\\");
    const newBack = newProjectPath.replace(/\//g, "\\");
    const oldJsonEscaped = oldBack.replace(/\\/g, "\\\\");
    const newJsonEscaped = newBack.replace(/\\/g, "\\\\");
    const oldFwd = oldProjectPath.replace(/\\/g, "/");
    const newFwd = newProjectPath.replace(/\\/g, "/");
    const oldEncoded = getAgent('claude').encodeProjectDir(oldProjectPath);
    const newEncoded = getAgent('claude').encodeProjectDir(newProjectPath);

    for (const file of files) {
      const filePath = join(claudeDir, file);
      let content = readFileSync(filePath, "utf-8");
      let changed = false;
      if (content.includes(oldJsonEscaped)) {
        content = content.split(oldJsonEscaped).join(newJsonEscaped);
        changed = true;
      }
      if (content.includes(oldFwd)) {
        content = content.split(oldFwd).join(newFwd);
        changed = true;
      }
      if (content.includes(oldEncoded)) {
        content = content.split(oldEncoded).join(newEncoded);
        changed = true;
      }
      if (changed) writeFileSync(filePath, content);
    }
  } catch {}
}

function doRename(cat: Category, oldName: string, newName: string): MoveResult {
  const oldPath = join(cat.path, oldName);
  const newPath = join(cat.path, newName);
  if (!existsSync(oldPath)) throw new Error(`Project not found: ${oldName}`);
  if (existsSync(newPath)) throw new Error(`Target already exists: ${newName}`);

  renameSync(oldPath, newPath);

  let claudeRenamed = false;
  // Route through the Claude adapter — when a user renames a project on
  // disk, we follow up by renaming the matching `~/.claude/projects/`
  // folder so subsequent session resume works.
  const claudeProjectsDir = getAgent('claude').sessionsRoot(homedir());
  const oldEncoded = getAgent('claude').encodeProjectDir(join(cat.path, oldName));
  const newEncoded = getAgent('claude').encodeProjectDir(join(cat.path, newName));
  const oldClaudeDir = join(claudeProjectsDir, oldEncoded);
  const newClaudeDir = join(claudeProjectsDir, newEncoded);

  if (existsSync(oldClaudeDir) && !existsSync(newClaudeDir)) {
    renameSync(oldClaudeDir, newClaudeDir);
    claudeRenamed = true;
    getAgent('claude').invalidateDiscoveryCache();
    updateSessionPaths(newClaudeDir, oldPath, newPath);
  }

  return { oldName, newName, claudeRenamed };
}

export function renameProject(cat: Category, oldName: string, newName: string): MoveResult {
  if (newName === oldName) return { oldName, newName, claudeRenamed: false };
  return doRename(cat, oldName, newName);
}

export function moveProjectPrefix(cat: Category, oldName: string, targetPrefix: string): MoveResult {
  const baseName = stripCurrentPrefix(oldName, cat.virtualFolders);
  const newName = applyPrefix(baseName, targetPrefix);
  if (newName === oldName) return { oldName, newName, claudeRenamed: false };
  return doRename(cat, oldName, newName);
}
