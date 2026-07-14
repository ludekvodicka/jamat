import { join } from "path";
import { homedir } from "os";

import { getFolders, buildMenuEntries, matchesVirtualPrefix, stripVirtualPrefix, loadProjectConfig, invalidateProjectConfigCache } from "./projects.js";
import { getAgent } from "../agents/index.js";
import { statsKey } from "./stats.js";
import { formatRelativeDate } from "./pure.js";
import type { MenuState, MenuItem, SessionPickerItem, RenderLayout } from "../types.js";
import { SEARCH_ITEM, SEPARATOR_ITEM, CROSS_FOLDER_THRESHOLD } from "../types.js";
import type { AgentId } from "../types/contracts.js";
import type { SessionInfo, LatestSessionMeta } from "../types/session.js";
import { listAvailableAgents } from "../agents/index.js";

export function invalidateCaches(s: MenuState) {
  for (const id of s.availableAgents) getAgent(id).invalidateDiscoveryCache();
  invalidateProjectConfigCache();
  s.crossFolderCache.clear();
  s.sessionMetaCache = buildUnionSessionMetaCache(s.cat.path, s.cachedFolderNames, s.availableAgents);
}

/**
 * Latest-session meta per project folder, UNIONED across the available agents:
 * a folder's row shows the newest activity of ANY agent that has sessions there,
 * so a mixed Claude+Codex project isn't misreported by whichever agent happens
 * to be selected. (gap #4)
 */
export function buildUnionSessionMetaCache(catPath: string, folderNames: string[], agents: AgentId[]): Map<string, LatestSessionMeta> {
  const union = new Map<string, LatestSessionMeta>();
  const ids = agents.length > 0 ? agents : listAvailableAgents().map((a) => a.id);
  for (const id of ids) {
    for (const [folder, meta] of getAgent(id).buildSessionMetaCache(catPath, folderNames)) {
      const existing = union.get(folder);
      if (!existing || meta.lastActivity > existing.lastActivity) union.set(folder, meta);
    }
  }
  return union;
}

/** Available agents with the currently-selected one first (drives new-session row order). */
function orderedAgents(s: MenuState): AgentId[] {
  const avail = s.availableAgents.length > 0 ? s.availableAgents : [s.selectedAgent];
  const rest = avail.filter((a) => a !== s.selectedAgent);
  return avail.includes(s.selectedAgent) ? [s.selectedAgent, ...rest] : avail;
}

/**
 * When the active category yields few matches, search every OTHER category too
 * and return a `-----` separator followed by `crossFolder` items (each carrying
 * its owning category index/label). Folder names per category are cached in
 * `s.crossFolderCache` so we walk each category's directory at most once.
 * Returns [] when the query is empty or the in-category hit count meets the
 * threshold — in both cases there's nothing to append.
 */
function buildCrossFolderItems(s: MenuState, q: string, inCategoryCount: number): MenuItem[] {
  if (!q || inCategoryCount >= CROSS_FOLDER_THRESHOLD) return [];

  const out: MenuItem[] = [];
  for (let ci = 0; ci < s.categories.length; ci++) {
    if (ci === s.catIndex) continue;
    const cat = s.categories[ci];
    let folders = s.crossFolderCache.get(ci);
    if (!folders) {
      folders = getFolders(cat, s.stats, s.sortMode);
      s.crossFolderCache.set(ci, folders);
    }
    for (const f of folders) {
      if (!f.toLowerCase().includes(q)) continue;
      const displayName = f.includes("/") ? f.replace(/\//g, "-") : f;
      out.push({ kind: "crossFolder", name: f, displayName, catIndex: ci, catLabel: cat.label });
    }
  }

  return out.length > 0 ? [SEPARATOR_ITEM, ...out] : [];
}

export function clampScroll(s: MenuState) {
  if (s.selected < s.scrollOffset) s.scrollOffset = s.selected;
  else if (s.selected >= s.scrollOffset + s.visibleRows) s.scrollOffset = s.selected - s.visibleRows + 1;
}

export function computeLayout(s: MenuState): RenderLayout {
  const projectConfigs = new Map<string, { isolated: boolean }>();
  const folders = s.allEntries.filter((it): it is Extract<typeof it, { kind: "folder" }> => it.kind === "folder");
  for (const it of folders) {
    const cfg = loadProjectConfig(join(s.cat.path, it.name));
    // Suppress the 🐳 isolation marker (and its name-width allowance) when the
    // menu isn't offering Docker isolation — see `dockerIsolationEnabled`.
    projectConfigs.set(it.name, { isolated: cfg.isolated && s.dockerIsolationEnabled });
  }

  const nameWidths = folders.map((it) => {
    const iso = projectConfigs.get(it.name)?.isolated ?? false;
    return it.displayName.length + (iso ? 3 : 0);
  });
  const maxNameW = Math.max(0, ...nameWidths);

  let maxActivityW = 0;
  for (const it of folders) {
    const entry = s.stats[statsKey(s.cat, it.name)];
    const meta = s.sessionMetaCache.get(it.name);
    if (entry && entry.count > 0 && meta) {
      const actW = formatRelativeDate(meta.lastActivity.toISOString()).length;
      if (actW > maxActivityW) maxActivityW = actW;
    }
  }

  return { maxNameW, maxActivityW, projectConfigs };
}

export function applySearch(s: MenuState) {
  const q = s.searchQuery.toLowerCase();
  let inCategory: MenuItem[];
  if (s.currentVirtualFolder) {
    const allMatching = s.cachedFolderNames.filter((f) =>
      matchesVirtualPrefix(f, s.currentVirtualFolder!)
    );
    const filtered = q
      ? allMatching.filter((f) => {
          const stripped = stripVirtualPrefix(f, s.currentVirtualFolder!);
          return f.toLowerCase().includes(q) || stripped.toLowerCase().includes(q);
        })
      : allMatching;
    inCategory = filtered.map<MenuItem>((f) => {
      const stripped = stripVirtualPrefix(f, s.currentVirtualFolder!);
      return { kind: "folder", name: f, displayName: stripped.includes("/") ? stripped.replace(/\//g, "-") : stripped };
    });
  } else {
    const filtered = q ? s.cachedFolderNames.filter((f) => f.toLowerCase().includes(q)) : s.cachedFolderNames;
    inCategory = filtered.map<MenuItem>((f) => ({
      kind: "folder",
      name: f,
      displayName: f.includes("/") ? f.replace(/\//g, "-") : f,
    }));
  }

  // Too few in-category hits → widen the search to the other categories,
  // appended under a `-----` separator.
  s.items = [...inCategory, ...buildCrossFolderItems(s, q, inCategory.length)];

  if (s.selected >= s.items.length) s.selected = s.items.length - 1;
  if (s.selected < 0) s.selected = 0;
  // Never leave the cursor parked on the (non-selectable) separator.
  if (s.items[s.selected]?.kind === "separator") {
    s.selected = nextSelectable(s.items, s.selected, 1);
  }
  s.scrollOffset = 0;
}

/**
 * Index of the next selectable item from `from` stepping by `dir` (+1/-1),
 * wrapping around and skipping `separator` rows. Returns `from` unchanged if no
 * selectable item exists (all separators — shouldn't happen in practice).
 */
export function nextSelectable(items: MenuItem[], from: number, dir: 1 | -1): number {
  if (items.length === 0) return 0;
  let i = from;
  for (let step = 0; step < items.length; step++) {
    i = (i + dir + items.length) % items.length;
    if (items[i]?.kind !== "separator") return i;
  }
  return from;
}

export function enterSearch(s: MenuState) {
  s.searchMode = true;
  s.searchQuery = "";
  applySearch(s);
  s.selected = 0;
  s.scrollOffset = 0;
}

export function exitSearch(s: MenuState) {
  s.searchMode = false;
  s.searchQuery = "";
  s.items = [SEARCH_ITEM, ...s.allEntries];
  s.selected = s.allEntries.length > 0 ? 1 : 0;
  s.scrollOffset = 0;
}

export function enterVirtualFolder(s: MenuState, prefix: string) {
  s.currentVirtualFolder = prefix;
  s.allEntries = buildMenuEntries(s.cat, s.cachedFolderNames, s.currentVirtualFolder, s.virtualFoldersEnabled);
  s.items = [SEARCH_ITEM, ...s.allEntries];
  s.selected = s.allEntries.length > 0 ? 1 : 0;
  s.scrollOffset = 0;
  s.layout = computeLayout(s);
}

export function exitVirtualFolder(s: MenuState) {
  s.currentVirtualFolder = null;
  s.allEntries = buildMenuEntries(s.cat, s.cachedFolderNames, s.currentVirtualFolder, s.virtualFoldersEnabled);
  s.items = [SEARCH_ITEM, ...s.allEntries];
  s.selected = s.allEntries.length > 0 ? 1 : 0;
  s.scrollOffset = 0;
  s.layout = computeLayout(s);
}

export function rebuildItems(s: MenuState, refreshSessionMeta = false) {
  s.cachedFolderNames = getFolders(s.cat, s.stats, s.sortMode);
  if (refreshSessionMeta) {
    invalidateCaches(s);
  }
  s.allEntries = buildMenuEntries(s.cat, s.cachedFolderNames, s.currentVirtualFolder, s.virtualFoldersEnabled);
  if (s.searchMode) {
    applySearch(s);
  } else {
    s.items = [SEARCH_ITEM, ...s.allEntries];
    if (s.selected >= s.items.length) s.selected = s.items.length - 1;
    if (s.selected < 0) s.selected = 0;
  }
  if (s.scrollOffset > 0 && s.scrollOffset >= s.items.length - s.visibleRows) {
    s.scrollOffset = Math.max(0, s.items.length - s.visibleRows);
  }
  s.layout = computeLayout(s);
}

export function switchCategory(s: MenuState, newIndex: number) {
  s.tabMemory.set(s.catIndex, { selected: s.selected, scrollOffset: s.scrollOffset });
  s.catIndex = newIndex;
  s.cat = s.categories[s.catIndex];
  s.currentVirtualFolder = null;
  s.cachedFolderNames = getFolders(s.cat, s.stats, s.sortMode);
  s.allEntries = buildMenuEntries(s.cat, s.cachedFolderNames, s.currentVirtualFolder, s.virtualFoldersEnabled);
  s.sessionMetaCache = buildUnionSessionMetaCache(s.cat.path, s.cachedFolderNames, s.availableAgents);
  exitSearch(s);
  const saved = s.tabMemory.get(s.catIndex);
  if (saved && saved.selected < s.items.length) {
    s.selected = saved.selected;
    s.scrollOffset = Math.min(saved.scrollOffset, Math.max(0, s.items.length - s.visibleRows));
  }
  s.layout = computeLayout(s);
}

export function openSessionPicker(s: MenuState, folderName: string) {
  const folderPath = join(s.cat.path, folderName);
  const home = homedir();
  const agents = orderedAgents(s);

  // One `New <Agent> session` row per available agent (selected first), then the
  // resume rows MERGED across agents and sorted by recency — so a project with
  // both Claude and Codex sessions shows all of them in one list, each badged
  // with its owner. (resolves gaps #4/#15 — no Esc→Tab→re-open to see the other agent)
  s.spProjectDirs = new Map();
  const merged: { session: SessionInfo; agent: AgentId }[] = [];
  for (const id of agents) {
    const agent = getAgent(id);
    // `homeDir` is part of the adapter contract; the Claude adapter resolves home internally.
    const dir = agent.findProjectDir(folderPath, home);
    s.spProjectDirs.set(id, dir);
    if (dir) for (const session of agent.listSessionsForProject(dir, home)) merged.push({ session, agent: id });
  }
  merged.sort((a, b) => new Date(b.session.lastActivity).getTime() - new Date(a.session.lastActivity).getTime());
  s.spFolderName = folderName;

  const items: SessionPickerItem[] = agents.map((agent) => ({ kind: "new-session", agent }));
  if (merged.length > 0) {
    const [latest, ...rest] = merged;
    items.push(latest.session.active
      ? { kind: "session", session: latest.session, agent: latest.agent }
      : { kind: "last-session", session: latest.session, agent: latest.agent });
    for (const m of rest) items.push({ kind: "session", session: m.session, agent: m.agent });
  }
  s.spItems = items;

  s.spSelected = 0;
  s.spScrollOffset = 0;
  s.spPreviewCache = new Map();
  s.submenu = "session-picker";
}
