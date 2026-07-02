import { homedir } from "os";
import { formatRelativeDate, formatDuration } from "../core/menu-core/pure.js";
import { statsKey } from "../core/menu-core/stats.js";
import { getAgent, resolveAgentForSessionId } from "../core/agents/index.js";
import type { AgentId, MenuState, SessionPickerItem, SortMode } from "../core/types.js";

function agentBadge(agentId: AgentId | null): string {
  if (!agentId) return "  ";
  return agentId === "claude" ? "C " : "X ";
}

export function renderMovePrefix(s: MenuState) {
  process.stdout.write("\x1b[?2026h");
  process.stdout.write("\x1b[2J\x1b[H");
  const rows = process.stdout.rows || 24;
  console.log(`  \x1b[1mMove "${s.mpFolderName}" to:\x1b[0m`);
  console.log();
  for (let i = 0; i < s.mpTargets.length; i++) {
    const t = s.mpTargets[i];
    if (i === s.mpSelected) {
      console.log(`  \x1b[36m❯ \x1b[1m${t.title}\x1b[0m`);
    } else {
      console.log(`    \x1b[37m${t.title}\x1b[0m`);
    }
  }
  process.stdout.write(`\x1b[${rows};0H  \x1b[90mEsc Cancel   \x1b[0m\x1b[90m↑↓ Navigate   Enter to move\x1b[0m`);
  process.stdout.write("\x1b[?2026l");
}

export function render(s: MenuState) {
  const K = "\x1b[K";
  const lines: string[] = [];
  const ln = (text = "") => lines.push(text + K);

  const LABEL_W = "Folder: ".length;

  const catDisplay = s.categories.map((c, i) =>
    i === s.catIndex
      ? `\x1b[7m ${c.label} \x1b[0m`
      : `  \x1b[90m${c.label}\x1b[0m  `
  ).join(" ");
  let breadcrumb = "";
  if (s.currentVirtualFolder) {
    const vf = s.cat.virtualFolders.find((v) => v.prefix === s.currentVirtualFolder);
    if (vf) breadcrumb = `  \x1b[90m›\x1b[0m \x1b[1m${vf.title}\x1b[0m`;
  }
  ln(`  ${"Folder:".padEnd(LABEL_W)}${catDisplay}${breadcrumb}  \x1b[90m← →\x1b[0m`);

  if (s.searchMode) {
    ln(`  \x1b[32;1m🔍 Search: ${s.searchQuery}\x1b[90m_\x1b[0m`);
  } else {
    ln(`  \x1b[90m↑ ↓ to navigate, Enter to select, Esc/q to ${s.currentVirtualFolder ? "back" : "quit"}\x1b[0m`);
  }
  ln();

  const end = Math.min(s.scrollOffset + s.visibleRows, s.items.length);
  if (s.scrollOffset > 0) {
    ln("  \x1b[90m  ▲ more above\x1b[0m");
  }

  const { maxNameW, maxActivityW, projectConfigs } = s.layout;

  for (let i = s.scrollOffset; i < end; i++) {
    const item = s.items[i];

    if (item.kind === "separator") {
      // Divider between the active category's matches and the cross-category
      // matches below it. Not selectable.
      ln(`  \x1b[90m${"─".repeat(20)} other folders \x1b[0m`);
    } else if (item.kind === "crossFolder") {
      if (i === s.selected) {
        ln(`  \x1b[36m❯ \x1b[1m${item.catLabel}\x1b[0m \x1b[90m:\x1b[0m \x1b[1m${item.displayName}\x1b[0m`);
      } else {
        ln(`    \x1b[90m${item.catLabel} : \x1b[37m${item.displayName}\x1b[0m`);
      }
    } else if (item.kind === "search") {
      const text = "/ Search";
      if (i === s.selected) {
        ln(`  \x1b[36m❯ \x1b[32;1m${text}\x1b[0m`);
      } else {
        ln(`    \x1b[32m${text}\x1b[0m`);
      }
    } else if (item.kind === "virtual") {
      const text = `📁 ${item.title} (${item.count})`;
      if (i === s.selected) {
        ln(`  \x1b[36m❯ \x1b[1m${text}\x1b[0m`);
      } else {
        ln(`    \x1b[90m${text}\x1b[0m`);
      }
    } else {
      const entry = s.stats[statsKey(s.cat, item.name)];
      const iso = projectConfigs.get(item.name)?.isolated ?? false;
      const isoTag = iso ? " 🐳" : "";
      const displayName = item.displayName + isoTag;
      const padding = " ".repeat(Math.max(0, maxNameW - item.displayName.length - (iso ? 3 : 0)));
      let suffix = "";
      if (entry && entry.count > 0) {
        const meta = s.sessionMetaCache.get(item.name);
        const datePart = meta
          ? `${formatRelativeDate(meta.lastActivity.toISOString()).padEnd(maxActivityW)} (${formatDuration(meta.createdAt.toISOString())} old)`
          : formatRelativeDate(entry.lastUsed);
        const statsText = `  ${String(entry.count).padStart(3)}× | ${datePart}`;
        suffix = i === s.selected
          ? `\x1b[37m${statsText}\x1b[0m`
          : `\x1b[90m${statsText}\x1b[0m`;
      }

      if (i === s.selected) {
        ln(`  \x1b[36m❯ \x1b[1m${displayName}\x1b[0m${padding}${suffix}`);
      } else {
        ln(`    \x1b[37m${displayName}\x1b[0m${padding}${suffix}`);
      }
    }
  }

  if (end < s.items.length) {
    ln("  \x1b[90m  ▼ more below\x1b[0m");
  }

  ln();
  const selectedItem = s.items[s.selected];
  if (!selectedItem) {
    ln(`  \x1b[90m  No matches\x1b[0m`);
  } else if (selectedItem.kind === "search") {
    ln(`  \x1b[33m→ Press Enter to search projects\x1b[0m`);
  } else if (selectedItem.kind === "virtual") {
    ln(`  \x1b[33m→ Open \x1b[1m${selectedItem.title}\x1b[0m`);
  } else if (selectedItem.kind === "crossFolder") {
    ln(`  \x1b[33m→ Select session \x1b[0min \x1b[1m${selectedItem.displayName}\x1b[0m \x1b[90m(${selectedItem.catLabel})\x1b[0m`);
  } else if (selectedItem.kind === "separator") {
    // Not selectable; rendered only as a guard for exhaustiveness.
  } else {
    ln(`  \x1b[33m→ Select session \x1b[0min \x1b[1m${selectedItem.displayName}\x1b[0m`);
  }

  const rows = process.stdout.rows || 24;

  let actionBar = "";
  if (s.submenu === "docker") {
    actionBar = `  \x1b[7m Docker-Isolation \x1b[0m \x1b[90mEsc Back   F1 Shell   F2 Rebuild Image   F3 Sync Auth\x1b[0m`;
  } else if (s.submenu === "custom") {
    const items = s.customPath.length ? s.customPath[s.customPath.length - 1].items ?? [] : s.customMenus;
    const crumb = s.customPath.length ? s.customPath.map((n) => n.label).join(" › ") : "Actions";
    const keys = items.map((n, i) => `${(n.key ?? `f${i + 1}`).toUpperCase()} ${n.label}${n.items ? " ›" : ""}`).join("   ");
    actionBar = `  \x1b[7m ${crumb} \x1b[0m \x1b[90mEsc Back   ${keys}\x1b[0m`;
  } else if (s.submenu === "manage") {
    const moveHint = s.cat.virtualFolders.length > 0 ? "F5 Move   " : "";
    actionBar = `  \x1b[7m Manage \x1b[0m \x1b[90mEsc Back   F1 Create New   F2 Archive   F3 Clear Stats   ${moveHint}F6 Rename   F8 Delete\x1b[0m`;
  } else if (s.submenu === "sort") {
    const sortLabels: Record<SortMode, string> = { usage: "Usage Count", recent: "Last Used", alpha: "Alphabetical" };
    const f1h = s.sortMode === "usage" ? `\x1b[7m F1 ${sortLabels.usage} \x1b[0m\x1b[90m` : `F1 ${sortLabels.usage}`;
    const f2h = s.sortMode === "recent" ? `\x1b[7m F2 ${sortLabels.recent} \x1b[0m\x1b[90m` : `F2 ${sortLabels.recent}`;
    const f3h = s.sortMode === "alpha" ? `\x1b[7m F3 ${sortLabels.alpha} \x1b[0m\x1b[90m` : `F3 ${sortLabels.alpha}`;
    const f4h = s.virtualFoldersEnabled ? `\x1b[7m F4 Folders:Grouped \x1b[0m\x1b[90m` : `\x1b[7m F4 Folders:Flat \x1b[0m\x1b[90m`;
    actionBar = `  \x1b[7m Sort \x1b[0m \x1b[90mEsc Back   ${f1h}   ${f2h}   ${f3h}   ${f4h}\x1b[0m`;
  } else if (s.searchMode) {
    actionBar = `  \x1b[90mEsc Cancel   Type to filter   Enter to select\x1b[0m`;
  } else {
    const sortLabel: Record<SortMode, string> = { usage: "Usage", recent: "Recent", alpha: "A-Z" };
    const vfLabel = s.virtualFoldersEnabled ? "Grp" : "Flat";
    const escLabel = s.currentVirtualFolder ? "Esc Back" : "Esc Exit";
    const selItem = s.items[s.selected];
    const dockerAvail = selItem && selItem.kind === "folder";
    const f3 = dockerAvail ? "F3 Docker" : "\x1b[2mF3 Docker\x1b[22m\x1b[90m";
    // Agent indicator. Hidden when only one agent is available (per R7) —
    // the cycle key would be a no-op and the screen real estate is tight.
    let agentHint = "";
    if (s.availableAgents.length > 1) {
      const name = getAgent(s.selectedAgent).displayName;
      agentHint = `   \x1b[7m Tab Agent:${name} \x1b[0m\x1b[90m`;
    }
    actionBar = `  \x1b[90m${escLabel}   F1 Search   F2 Manage   ${f3}   F4 Sort:${sortLabel[s.sortMode]}|${vfLabel}${agentHint}\x1b[0m`;
  }

  process.stdout.write(
    "\x1b[?2026h\x1b[H" +
    lines.join("\n") +
    "\x1b[J" +
    `\x1b[${rows};0H${actionBar}${K}` +
    "\x1b[?2026l"
  );
}

export function renderSessionPicker(
  items: SessionPickerItem[],
  selected: number,
  scrollOffset: number,
  folderName: string,
  previewLines: string[],
  antiFlicker: boolean,
  showAgentBadges: boolean = false,
) {
  process.stdout.write("\x1b[?2026h");
  process.stdout.write("\x1b[2J\x1b[H");

  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 24;

  function sessionPrefix(item: SessionPickerItem): string {
    if (item.kind === "new-session") return "";
    if (item.kind === "last-session") return "★ Last: ";
    if (item.session.active) return "● Running: ";
    return "";
  }

  let maxNameW = "+ New session".length;
  let maxSessActivityW = 0;
  let maxDateSuffixW = 0;
  for (const item of items) {
    if (item.kind !== "new-session") {
      const sess = item.session;
      const pfx = sessionPrefix(item);
      const rawName = sess.slug || (sess.firstUserMessage ? sess.firstUserMessage.slice(0, 30) : sess.sessionId.slice(0, 8));
      const nameLen = pfx.length + rawName.length;
      if (nameLen > maxNameW) maxNameW = nameLen;
      const actW = formatRelativeDate(new Date(sess.lastActivity).toISOString()).length;
      if (actW > maxSessActivityW) maxSessActivityW = actW;
      const suffixW = ` (${formatDuration(new Date(sess.createdAt).toISOString())} old)`.length;
      if (suffixW > maxDateSuffixW) maxDateSuffixW = suffixW;
    }
  }
  // `dateStr` = `<relative-date padded-to-maxSessActivityW>` + ` (<duration> old)`.
  // We want the **start** of dateStr to line up across rows (not just the end),
  // so we pin the total width to `maxSessActivityW + maxDateSuffixW`. Without
  // this, "9m ago (54min old)" is wider than "1h ago (1h old)" and shifts the
  // whole column left for that row.
  const maxDateW = maxSessActivityW + maxDateSuffixW;

  const contentW = Math.min(cols - 4, 2 + maxNameW + 3 + maxDateW);
  const leftMargin = Math.max(2, Math.floor((cols - contentW) / 2));
  const pad = " ".repeat(leftMargin);
  const innerPad = " ".repeat(leftMargin + 2);

  console.log(`${pad}\x1b[1mSessions for: ${folderName}\x1b[0m`);
  console.log();

  const maxListRows = Math.min(items.length, Math.max(5, Math.floor((rows - 8) * 0.45)));
  const end = Math.min(scrollOffset + maxListRows, items.length);

  if (scrollOffset > 0) {
    console.log(`${innerPad}\x1b[90m▲ more above\x1b[0m`);
  }

  for (let i = scrollOffset; i < end; i++) {
    const item = items[i];

    if (item.kind === "new-session") {
      if (i === selected) {
        console.log(`${pad}\x1b[36m❯ \x1b[32;1m+ New session\x1b[0m`);
      } else {
        console.log(`${innerPad}\x1b[32m+ New session\x1b[0m`);
      }
      continue;
    }

    const sess = item.session;
    const pfx = sessionPrefix(item);
    const rawName = sess.slug || (sess.firstUserMessage ? sess.firstUserMessage.slice(0, 30) : sess.sessionId.slice(0, 8));
    const plainName = pfx + rawName;
    const rawDateStr = `${formatRelativeDate(new Date(sess.lastActivity).toISOString()).padEnd(maxSessActivityW)} (${formatDuration(new Date(sess.createdAt).toISOString())} old)`;
    // Pad the right side so every row's dateStr has the same width — keeps
    // the activity time + duration column left-aligned across rows.
    const dateStr = rawDateStr.padEnd(maxDateW);
    const availNameW = Math.max(3, contentW - dateStr.length - 2);
    const truncPlain = plainName.length > availNameW
      ? plainName.slice(0, availNameW - 3) + "..."
      : plainName;

    let coloredName: string;
    if (item.kind === "last-session") {
      const pfxColor = "\x1b[33m★ Last: \x1b[0m";
      const nameText = truncPlain.slice(pfx.length);
      coloredName = i === selected
        ? `${pfxColor}\x1b[1m${nameText}\x1b[0m`
        : `${pfxColor}\x1b[37m${nameText}\x1b[0m`;
    } else if (sess.active) {
      const pfxColor = "\x1b[36m● Running: \x1b[0m";
      const nameText = truncPlain.slice(pfx.length);
      coloredName = i === selected
        ? `${pfxColor}\x1b[1m${nameText}\x1b[0m`
        : `${pfxColor}\x1b[37m${nameText}\x1b[0m`;
    } else {
      coloredName = i === selected
        ? `\x1b[1m${truncPlain}\x1b[0m`
        : `\x1b[37m${truncPlain}\x1b[0m`;
    }

    const namePadding = " ".repeat(Math.max(1, contentW - 2 - truncPlain.length - dateStr.length));
    const badge = showAgentBadges
      ? `\x1b[90m${agentBadge(resolveAgentForSessionId(sess.sessionId, homedir()))}\x1b[0m`
      : "";

    if (i === selected) {
      console.log(`${pad}\x1b[36m❯ \x1b[0m${badge}${coloredName}${namePadding}\x1b[37m${dateStr}\x1b[0m`);
    } else {
      console.log(`${innerPad}${badge}${coloredName}${namePadding}\x1b[90m${dateStr}\x1b[0m`);
    }
  }

  if (end < items.length) {
    console.log(`${innerPad}\x1b[90m▼ more below\x1b[0m`);
  }

  console.log();
  const selItem = items[selected];
  if (selItem) {
    if (selItem.kind === "new-session") {
      console.log(`${pad}\x1b[33m→ New session\x1b[0m`);
    } else {
      const sess = selItem.session;
      const name = sess.slug || (sess.firstUserMessage ? sess.firstUserMessage.slice(0, 30) : sess.sessionId.slice(0, 8));
      const action = selItem.kind === "last-session"
        ? (sess.active ? "Fork last" : "Resume last")
        : (sess.active ? "Fork" : "Resume");
      console.log(`${pad}\x1b[33m→ ${action}: \x1b[1m${name}\x1b[0m`);
    }
  }

  let metadataRows = 0;
  if (selItem && selItem.kind !== "new-session") {
    metadataRows = 1 + 2 + (selItem.session.slug ? 1 : 0) + 1;
  }
  const usedRows = 2 + (scrollOffset > 0 ? 1 : 0) + (end - scrollOffset) + (end < items.length ? 1 : 0) + 2 + 1 + metadataRows;
  const previewRows = Math.max(0, rows - usedRows - 2);

  if (previewRows > 0 && selItem && selItem.kind !== "new-session") {
    const sess = selItem.session;
    console.log();
    console.log(`  \x1b[90mSession ID:\x1b[0m \x1b[37m${sess.sessionId}\x1b[0m`);
    if (sess.slug) {
      console.log(`  \x1b[90mLabel:\x1b[0m \x1b[37m${sess.slug}\x1b[0m`);
    }
    const createdStr = sess.createdAt.toLocaleString();
    const lastActStr = sess.lastActivity.toLocaleString();
    console.log(`  \x1b[90mCreated:\x1b[0m \x1b[37m${createdStr}\x1b[0m`);
    console.log(`  \x1b[90mLast Activity:\x1b[0m \x1b[37m${lastActStr}\x1b[0m`);
  }

  if (previewRows > 0 && previewLines.length > 0) {
    console.log(`  \x1b[90m${"─".repeat(Math.min(cols - 4, 60))}\x1b[0m`);
    const maxPreview = Math.min(previewLines.length, previewRows);
    for (let p = 0; p < maxPreview; p++) {
      const pLine = previewLines[p].slice(0, cols - 4);
      console.log(`  \x1b[90m${pLine}\x1b[0m`);
    }
  }

  let enterLabel = "Enter New";
  if (selItem && selItem.kind !== "new-session") {
    enterLabel = selItem.session.active ? "Enter Fork" : "Enter Resume";
  }
  const f9hint = antiFlicker ? `   \x1b[7m F9 NoFlicker:ON \x1b[0m\x1b[90m` : `   F9 NoFlicker`;
  process.stdout.write(`\x1b[${rows};0H  \x1b[90mEsc Back   ${enterLabel}   ↑↓ Navigate${f9hint}\x1b[0m`);
  process.stdout.write("\x1b[?2026l");
}
