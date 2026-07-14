import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import * as readline from "readline";
import { tmpdir } from "os";

import { loadConfig } from "../core/config.js";
import { resolveUserDataDir } from "../core/userdata-path.js";
import { resolveConfigDir } from "../core/config-dir.js";
import type { MenuState, MenuItem, SubmenuType } from "../core/types.js";
import type { HandlerContext, HandlerResult } from "./handler-types.js";
import {
  createMenuState, getSessionPreview, getStatsPath,
  clampScroll, applySearch, enterSearch, exitSearch,
  enterVirtualFolder, exitVirtualFolder, switchCategory, openSessionPicker,
  loadProjectConfig,
} from "../core/menu-core/facade.js";
import { render, renderMovePrefix, renderSessionPicker } from "./render.js";
import {
  handleSearch,
  handleDocker,
  handleCustomMenu,
  handleManage,
  handleMovePrefix,
  handleSort,
  handleSessionPicker,
} from "./handlers.js";
import type { ActionConfig } from "./actions.js";

// Per-user data, NOT the repo: <config-dir>/menu-prefs.json (alongside usage-stats.json — the same
// portable dir the Electron app uses). Resolved in run() once --config-dir is known; this is the
// legacy fallback for the unlikely case run() hasn't set it.
let PREFS_FILE = join(resolveUserDataDir(), "menu-prefs.json");
const SELECTION_FILE = process.env['JAMAT_MENU_SELECTION_FILE'] ?? join(tmpdir(), "jamat-menu-selection.json");

function loadPrefs(): { antiFlicker: boolean } {
  try {
    if (existsSync(PREFS_FILE)) {
      return JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
    }
  } catch {}
  return { antiFlicker: true };
}

function savePrefs(prefs: { antiFlicker: boolean }) {
  mkdirSync(dirname(PREFS_FILE), { recursive: true });
  writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2) + "\n");
}

function run() {
  const configIdx = process.argv.indexOf("--config");
  if (configIdx === -1 || configIdx + 1 >= process.argv.length) {
    console.error("Usage: menu-tui.ts --config <path>");
    process.exit(1);
  }
  const configPath = process.argv[configIdx + 1];

  // The portable config-dir (--config-dir passed by executor / JAMAT_CONFIG_DIR) holds menu-prefs +
  // usage-stats. CLI is build-agnostic → no -debug split.
  const cdIdx = process.argv.indexOf("--config-dir");
  const explicitConfigDir = cdIdx !== -1 ? process.argv[cdIdx + 1] : (process.env["JAMAT_CONFIG_DIR"] ?? null);
  const CONFIG_DIR = resolveConfigDir({ explicit: explicitConfigDir });
  PREFS_FILE = join(CONFIG_DIR, "menu-prefs.json");

  const appConfig = loadConfig(configPath);
  const STATS_FILE = getStatsPath(CONFIG_DIR);

  const cfg: ActionConfig = { statsFile: STATS_FILE, selectionFile: SELECTION_FILE };

  const s = createMenuState(appConfig, loadPrefs(), CONFIG_DIR);

  function doRender() {
    if (s.submenu === "move-prefix") {
      renderMovePrefix(s);
      return;
    }
    if (s.submenu === "session-picker") {
      const preview = getSessionPreview(s);
      // Badges only meaningful when more than one agent is reachable —
      // otherwise every row would carry the same letter.
      const showBadges = s.availableAgents.length > 1;
      renderSessionPicker(s.spItems, s.spSelected, s.spScrollOffset, s.spFolderName, preview, s.antiFlicker, showBadges);
      return;
    }
    render(s);
  }

  process.stdout.write("\x1b]0;Jamat Menu\x07\x1b[2J");

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  doRender();

  process.stdout.on('resize', () => {
    s.visibleRows = Math.max(5, (process.stdout.rows || 24) - 10);
    doRender();
  });

  const submenuHandlers: Record<NonNullable<SubmenuType>, (s: MenuState, key: readline.Key, str: string, ctx: HandlerContext) => HandlerResult> = {
    "docker": (s, k, str, ctx) => handleDocker(s, k, str, ctx, cfg),
    "custom": (s, k, str, ctx) => handleCustomMenu(s, k, str, ctx, cfg),
    "manage": (s, k, str, ctx) => handleManage(s, k, str, ctx, cfg),
    "move-prefix": handleMovePrefix,
    "sort": handleSort,
    "session-picker": (s, k, str, ctx) => handleSessionPicker(s, k, str, ctx, cfg, savePrefs),
  };

  const keypressHandler = (_str: string, key: readline.Key) => {
    if (!key) return;

    if (key.ctrl && key.name === "c") {
      process.stdout.write("\x1b[2J\x1b[H");
      process.exit(0);
    }

    const ctx: HandlerContext = {
      suspendKeypress: () => process.stdin.removeAllListeners("keypress"),
      resumeKeypress: () => {
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        readline.emitKeypressEvents(process.stdin);
        process.stdin.resume();
        process.stdin.on("keypress", keypressHandler);
      },
      doRender,
    };

    if (s.searchMode) {
      const result = handleSearch(s, key, _str, ctx);
      if (result.needsRender) doRender();
      return;
    }

    if (s.submenu) {
      const handler = submenuHandlers[s.submenu];
      const result = handler(s, key, _str, ctx);
      if (result.needsRender) doRender();
      return;
    }

    if (key.name === "backspace" && s.currentVirtualFolder) {
      exitVirtualFolder(s);
      doRender();
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      if (s.currentVirtualFolder) {
        exitVirtualFolder(s);
        doRender();
        return;
      }
      process.stdout.write("\x1b[2J\x1b[H");
      process.exit(0);
    }

    if (key.name === "f1") {
      s.selected = 0;
      clampScroll(s);
      doRender();
      return;
    }

    if (key.name === "f2") {
      s.submenu = "manage";
      doRender();
      return;
    }

    if (key.name === "f3") {
      const sel = s.items[s.selected];
      if (sel && sel.kind === "folder") {
        const dir = join(s.cat.path, sel.name);
        const pcfg = loadProjectConfig(dir);
        if (pcfg.isolated) {
          s.submenu = "docker";
          doRender();
        } else if (s.customMenus.length) {
          s.customPath = [];
          s.customTargetDir = dir;
          s.submenu = "custom";
          doRender();
        }
      }
      return;
    }

    if (key.name === "f4") {
      s.submenu = "sort";
      doRender();
      return;
    }

    if (key.name === "tab" && s.availableAgents.length > 1) {
      // Cycle the SELECTED agent. It orders the picker's `New <Agent>` rows and is
      // the new-session default; the project rows now show a UNION of all agents'
      // activity, so there's no per-agent cache to rebuild here.
      const idx = s.availableAgents.indexOf(s.selectedAgent);
      s.selectedAgent = s.availableAgents[(idx + 1) % s.availableAgents.length];
      doRender();
      return;
    }

    if (key.name === "right") {
      switchCategory(s, (s.catIndex + 1) % s.categories.length);
    } else if (key.name === "left") {
      switchCategory(s, (s.catIndex - 1 + s.categories.length) % s.categories.length);
    } else if (key.name === "up") {
      s.selected = s.selected > 0 ? s.selected - 1 : s.items.length - 1;
    } else if (key.name === "down") {
      s.selected = s.selected < s.items.length - 1 ? s.selected + 1 : 0;
    } else if (key.name === "return") {
      const selectedItem = s.items[s.selected];
      if (!selectedItem) return;

      if (selectedItem.kind === "search") {
        enterSearch(s);
        doRender();
        return;
      }

      if (selectedItem.kind === "virtual") {
        enterVirtualFolder(s, selectedItem.prefix);
        doRender();
        return;
      }

      // Only plain folders reach here in normal (non-search) mode; separator /
      // crossFolder items exist solely inside search mode.
      if (selectedItem.kind === "folder") {
        openSessionPicker(s, selectedItem.name);
        doRender();
      }
    }

    if (_str && _str.length === 1 && !key.ctrl && !key.meta) {
      const selectedItem = s.items[s.selected];
      if (selectedItem && selectedItem.kind === "search") {
        enterSearch(s);
        s.searchQuery = _str;
        applySearch(s);
        doRender();
        return;
      }
      const ch = _str.toLowerCase();
      const startAfter = (ch === s.jumpChar) ? s.jumpLastIndex : -1;
      const jumpMatch = (it: MenuItem) =>
        (it.kind === "folder" && it.displayName.toLowerCase().startsWith(ch)) ||
        (it.kind === "virtual" && it.title.toLowerCase().startsWith(ch));
      let found = -1;
      for (let i = startAfter + 1; i < s.items.length; i++) {
        if (jumpMatch(s.items[i])) { found = i; break; }
      }
      if (found === -1) {
        for (let i = 0; i <= startAfter; i++) {
          if (jumpMatch(s.items[i])) { found = i; break; }
        }
      }
      if (found !== -1) {
        s.selected = found;
        s.jumpChar = ch;
        s.jumpLastIndex = found;
        clampScroll(s);
        doRender();
        return;
      }
    }

    clampScroll(s);
    doRender();
  };

  process.stdin.on("keypress", keypressHandler);
}

run();
