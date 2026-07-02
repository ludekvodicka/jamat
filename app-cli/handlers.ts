import {
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import * as readline from "readline";

import { matchesVirtualPrefix, moveProjectPrefix, renameProject } from "../core/menu-core/projects.js";
import { statsKey, saveStats, recordUsage } from "../core/menu-core/stats.js";
import { clampScroll, applySearch, enterSearch, exitSearch, switchCategory, openSessionPicker, rebuildItems, nextSelectable } from "../core/menu-core/transitions.js";
import { resolveAgentForSessionId } from "../core/agents/index.js";
import {
  promptFolderName,
  promptIsolated,
  confirmArchive,
  archiveFolder,
  confirmDelete,
  deleteFolder,
  launchInFolder,
  launchSessionResume,
  dispatchAction,
  type ActionConfig,
} from "./actions.js";
import type { MenuState, CustomMenuNode, CustomRun } from "../core/types.js";
import type { HandlerContext, HandlerResult } from "./handler-types.js";

export function handleSearch(s: MenuState, key: readline.Key, str: string, _ctx: HandlerContext): HandlerResult {
  if (key.name === "escape") {
    exitSearch(s);
    return { needsRender: true };
  }
  if (key.name === "backspace") {
    if (s.searchQuery.length > 0) {
      s.searchQuery = s.searchQuery.slice(0, -1);
      applySearch(s);
    } else {
      exitSearch(s);
    }
    return { needsRender: true };
  }
  if (key.name === "return") {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder") {
      exitSearch(s);
      openSessionPicker(s, selectedItem.name);
    } else if (selectedItem && selectedItem.kind === "crossFolder") {
      // Match in another category: switch context to that category (resets
      // path/stats/session caches via switchCategory, which also exits search)
      // then open its session picker against the matched project.
      switchCategory(s, selectedItem.catIndex);
      openSessionPicker(s, selectedItem.name);
    }
    return { needsRender: true };
  }
  if (key.name === "up") {
    s.selected = nextSelectable(s.items, s.selected, -1);
    clampScroll(s);
    return { needsRender: true };
  }
  if (key.name === "down") {
    s.selected = nextSelectable(s.items, s.selected, 1);
    clampScroll(s);
    return { needsRender: true };
  }
  if (key.name === "left") {
    exitSearch(s);
    switchCategory(s, (s.catIndex - 1 + s.categories.length) % s.categories.length);
    return { needsRender: true };
  }
  if (key.name === "right") {
    exitSearch(s);
    switchCategory(s, (s.catIndex + 1) % s.categories.length);
    return { needsRender: true };
  }
  if (str && str.length === 1 && !key.ctrl && !key.meta) {
    s.searchQuery += str;
    applySearch(s);
    return { needsRender: true };
  }
  return { needsRender: false };
}

export function handleDocker(s: MenuState, key: readline.Key, _str: string, _ctx: HandlerContext, cfg: ActionConfig): HandlerResult {
  if (key.name === "f1") {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder") {
      dispatchAction(cfg, "docker-shell", { dir: join(s.cat.path, selectedItem.name) });
    }
    return { needsRender: false };
  }
  if (key.name === "f2") { dispatchAction(cfg, "docker-rebuild"); return { needsRender: false }; }
  if (key.name === "f3") { dispatchAction(cfg, "docker-auth"); return { needsRender: false }; }
  if (key.name === "escape" || key.name === "q") {
    s.submenu = null;
    return { needsRender: true };
  }
  return { needsRender: false };
}

/** Items shown at the current depth of the `custom` submenu (root list or the deepest branch). */
export function currentCustomItems(s: MenuState): CustomMenuNode[] {
  return s.customPath.length ? s.customPath[s.customPath.length - 1].items ?? [] : s.customMenus;
}

/** "f1"→0 … "f12"→11, else -1. */
function fKeyIndex(name: string | undefined): number {
  const m = /^f(\d{1,2})$/.exec(name ?? "");
  if (!m) return -1;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 12 ? n - 1 : -1;
}

/** Substitute {dir}/{name} in the leaf's command before it leaves the menu (host stays dumb). */
function resolveRun(run: CustomRun, dir: string): CustomRun {
  const name = basename(dir);
  const sub = (v: string) => v.replace(/\{dir\}/g, dir).replace(/\{name\}/g, name);
  return {
    command: run.command,
    args: (run.args ?? []).map(sub),
    cwd: run.cwd ? sub(run.cwd) : undefined,
    pause: run.pause,
  };
}

export function handleCustomMenu(s: MenuState, key: readline.Key, _str: string, _ctx: HandlerContext, cfg: ActionConfig): HandlerResult {
  if (key.name === "escape" || key.name === "q") {
    if (s.customPath.length) s.customPath.pop();
    else s.submenu = null;
    return { needsRender: true };
  }
  const items = currentCustomItems(s);
  const byKey = items.find((n) => n.key && n.key === key.name);
  const idx = byKey ? items.indexOf(byKey) : fKeyIndex(key.name);
  const node = idx >= 0 && idx < items.length ? items[idx] : undefined;
  if (!node) return { needsRender: false };
  if (node.items) {
    s.customPath.push(node);
    return { needsRender: true };
  }
  if (node.run && s.customTargetDir) {
    dispatchAction(cfg, "custom-run", { run: resolveRun(node.run, s.customTargetDir), dir: s.customTargetDir });
  }
  return { needsRender: false };
}

function manageCreate(s: MenuState, ctx: HandlerContext, cfg: ActionConfig): HandlerResult {
  const activeVirtual = s.currentVirtualFolder;
  ctx.suspendKeypress();
  s.submenu = null;
  promptFolderName().then(async (rawName) => {
    if (!rawName) {
      process.stdout.write("\x1b[2J\x1b[H");
      ctx.resumeKeypress();
      ctx.doRender();
      return;
    }
    let name = rawName;
    if (activeVirtual && !matchesVirtualPrefix(name, activeVirtual)) {
      name = activeVirtual + name[0].toUpperCase() + name.slice(1);
    }
    // Only OFFER Docker isolation when the menu is configured to (dockerIsolation).
    const isolated = s.dockerIsolationEnabled ? await promptIsolated() : false;
    const folderPath = join(s.cat.path, name);
    try {
      mkdirSync(folderPath, { recursive: true });
    } catch (e: any) {
      console.error(`\n  Failed to create folder: ${e.message}`);
      process.exit(1);
    }
    if (isolated) {
      writeFileSync(
        join(folderPath, ".jamat.json"),
        JSON.stringify({ isolated: true }, null, 2) + "\n"
      );
    }
    process.stdout.write("\x1b[2J\x1b[H");
    launchInFolder(cfg, s.cat, name, "cc", s.stats, s.antiFlicker, s.selectedAgent);
  });
  return { needsRender: false };
}

function manageArchive(s: MenuState, folderName: string, displayName: string, ctx: HandlerContext): HandlerResult {
  ctx.suspendKeypress();
  confirmArchive(displayName).then((confirmed) => {
    if (confirmed) {
      try {
        archiveFolder(s.cat, folderName);
      } catch (e: any) {
        process.stdout.write("\x1b[2J\x1b[H");
        console.error(`  Failed to archive: ${e.message}`);
        process.exit(1);
      }
      rebuildItems(s, true);
    }
    s.submenu = null;
    ctx.resumeKeypress();
    ctx.doRender();
  });
  return { needsRender: false };
}

function manageDeleteHandler(s: MenuState, folderName: string, displayName: string, ctx: HandlerContext): HandlerResult {
  ctx.suspendKeypress();
  confirmDelete(displayName).then((confirmed) => {
    if (confirmed) {
      try {
        deleteFolder(s.cat, folderName);
      } catch (e: any) {
        process.stdout.write("\x1b[2J\x1b[H");
        console.error(`  Failed to delete: ${e.message}`);
        process.exit(1);
      }
      rebuildItems(s, true);
    }
    s.submenu = null;
    ctx.resumeKeypress();
    ctx.doRender();
  });
  return { needsRender: false };
}

function manageRename(s: MenuState, oldName: string, displayLabel: string, ctx: HandlerContext): HandlerResult {
  const flattenPrefix = oldName.includes("/") ? oldName.slice(0, oldName.lastIndexOf("/") + 1) : "";
  const activeVirtual = s.currentVirtualFolder;
  ctx.suspendKeypress();
  s.submenu = null;
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`\x1b[1m  Rename: ${displayLabel}\x1b[0m\n\n  New name: `);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("line", (answer) => {
    rl.close();
    if (!answer.trim()) {
      ctx.resumeKeypress();
      ctx.doRender();
      return;
    }
    let newName = flattenPrefix + answer.trim();
    if (activeVirtual && !matchesVirtualPrefix(newName, activeVirtual)) {
      newName = activeVirtual + newName[0].toUpperCase() + newName.slice(1);
    }
    if (newName === oldName) {
      ctx.resumeKeypress();
      ctx.doRender();
      return;
    }
    try {
      renameProject(s.cat, oldName, newName);
      rebuildItems(s, true);
    } catch (e: any) {
      process.stdout.write(`\n  \x1b[31mRename failed:\x1b[0m ${e.message}\n`);
      const hint = (e.code === "EBUSY") ? "\n  \x1b[33mClose any Claude session or editor open in this project.\x1b[0m\n" : "";
      process.stdout.write(hint);
      process.stdout.write(`\n  \x1b[90mPress any key to continue...\x1b[0m`);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      readline.emitKeypressEvents(process.stdin);
      process.stdin.resume();
      process.stdin.once("keypress", () => {
        ctx.resumeKeypress();
        ctx.doRender();
      });
      return;
    }
    ctx.resumeKeypress();
    ctx.doRender();
  });
  return { needsRender: false };
}

export function handleManage(s: MenuState, key: readline.Key, _str: string, ctx: HandlerContext, cfg: ActionConfig): HandlerResult {
  if (key.name === "f1") {
    return manageCreate(s, ctx, cfg);
  }
  if (key.name === "f2") {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder") {
      return manageArchive(s, selectedItem.name, selectedItem.displayName, ctx);
    }
  }
  if (key.name === "f3") {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder") {
      const sk = statsKey(s.cat, selectedItem.name);
      delete s.stats[sk];
      saveStats(cfg.statsFile, s.stats);
      rebuildItems(s);
      s.submenu = null;
      return { needsRender: true };
    }
  }
  if (key.name === "f5" && s.cat.virtualFolders.length > 0) {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder" && !selectedItem.name.includes("/")) {
      s.mpTargets = [{ prefix: "", title: "Root (no prefix)" }, ...[...s.cat.virtualFolders].sort((a, b) => a.title.localeCompare(b.title))];
      s.mpFolderName = selectedItem.displayName;
      s.mpSelected = 0;
      s.submenu = "move-prefix";
      return { needsRender: true };
    }
  }
  if (key.name === "f6") {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder") {
      return manageRename(s, selectedItem.name, selectedItem.displayName, ctx);
    }
  }
  if (key.name === "f8") {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder") {
      return manageDeleteHandler(s, selectedItem.name, selectedItem.displayName, ctx);
    }
  }
  if (key.name === "escape" || key.name === "q") {
    s.submenu = null;
    return { needsRender: true };
  }
  return { needsRender: false };
}

export function handleMovePrefix(s: MenuState, key: readline.Key, _str: string, ctx: HandlerContext): HandlerResult {
  if (key.name === "up") {
    s.mpSelected = s.mpSelected > 0 ? s.mpSelected - 1 : s.mpTargets.length - 1;
    return { needsRender: true };
  }
  if (key.name === "down") {
    s.mpSelected = s.mpSelected < s.mpTargets.length - 1 ? s.mpSelected + 1 : 0;
    return { needsRender: true };
  }
  if (key.name === "return") {
    const selectedItem = s.items[s.selected];
    if (selectedItem && selectedItem.kind === "folder") {
      const target = s.mpTargets[s.mpSelected];
      try {
        const result = moveProjectPrefix(s.cat, selectedItem.name, target.prefix);
        if (result.newName !== result.oldName) {
          rebuildItems(s, true);
        }
        s.submenu = null;
        return { needsRender: true };
      } catch (e: any) {
        s.submenu = null;
        process.stdout.write("\x1b[2J\x1b[H");
        const hint = e.code === "EBUSY"
          ? "Close any Claude session or editor open in this project."
          : "";
        console.log(`\n  \x1b[31mMove failed:\x1b[0m ${e.message}`);
        if (hint) console.log(`\n  \x1b[33m${hint}\x1b[0m`);
        console.log(`\n  \x1b[90mPress any key to continue...\x1b[0m`);
        process.stdin.once("keypress", () => { ctx.doRender(); });
        return { needsRender: false };
      }
    } else {
      s.submenu = null;
      return { needsRender: true };
    }
  }
  if (key.name === "escape" || key.name === "q") {
    s.submenu = null;
    return { needsRender: true };
  }
  return { needsRender: false };
}

export function handleSort(s: MenuState, key: readline.Key, _str: string, _ctx: HandlerContext): HandlerResult {
  const applySortMode = (mode: import("../core/menu-core/projects.js").SortMode) => {
    s.sortMode = mode;
    rebuildItems(s);
    s.submenu = null;
  };
  if (key.name === "f1") { applySortMode("usage"); return { needsRender: true }; }
  if (key.name === "f2") { applySortMode("recent"); return { needsRender: true }; }
  if (key.name === "f3") { applySortMode("alpha"); return { needsRender: true }; }
  if (key.name === "f4") {
    s.virtualFoldersEnabled = !s.virtualFoldersEnabled;
    if (!s.virtualFoldersEnabled) s.currentVirtualFolder = null;
    rebuildItems(s);
    return { needsRender: true };
  }
  if (key.name === "escape" || key.name === "q") {
    s.submenu = null;
    return { needsRender: true };
  }
  return { needsRender: false };
}

export function handleSessionPicker(s: MenuState, key: readline.Key, _str: string, _ctx: HandlerContext, cfg: ActionConfig, savePrefs: (prefs: { antiFlicker: boolean }) => void): HandlerResult {
  const maxListRows = Math.min(s.spItems.length, Math.max(5, Math.floor(((process.stdout.rows || 24) - 8) * 0.45)));

  if (key.name === "escape" || key.name === "q") {
    s.submenu = null;
    return { needsRender: true };
  }
  if (key.name === "up") {
    s.spSelected = s.spSelected > 0 ? s.spSelected - 1 : s.spItems.length - 1;
    if (s.spSelected < s.spScrollOffset) s.spScrollOffset = s.spSelected;
    else if (s.spSelected >= s.spScrollOffset + maxListRows) s.spScrollOffset = s.spSelected - maxListRows + 1;
    return { needsRender: true };
  }
  if (key.name === "down") {
    s.spSelected = s.spSelected < s.spItems.length - 1 ? s.spSelected + 1 : 0;
    if (s.spSelected < s.spScrollOffset) s.spScrollOffset = s.spSelected;
    else if (s.spSelected >= s.spScrollOffset + maxListRows) s.spScrollOffset = s.spSelected - maxListRows + 1;
    return { needsRender: true };
  }
  if (key.name === "return") {
    const item = s.spItems[s.spSelected];
    if (!item) return { needsRender: false };
    if (item.kind === "new-session") {
      launchInFolder(cfg, s.cat, s.spFolderName, "cc", s.stats, s.antiFlicker, s.selectedAgent);
      return { needsRender: false };
    }
    // Resume rows inherit the session file's owning adapter when known.
    // Falls back to the menu-level pick when no adapter recognizes the id
    // (e.g. file was deleted but the meta cache still has it).
    const owner = resolveAgentForSessionId(item.session.sessionId, homedir()) ?? s.selectedAgent;
    launchSessionResume(cfg, s.cat, s.spFolderName, item.session.sessionId, item.session.active, s.stats, s.antiFlicker, owner);
    return { needsRender: false };
  }
  if (key.name === "f9") {
    s.antiFlicker = !s.antiFlicker;
    savePrefs({ antiFlicker: s.antiFlicker });
    return { needsRender: true };
  }
  return { needsRender: false };
}
