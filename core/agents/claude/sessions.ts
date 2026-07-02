import {
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type { SessionInfo, LatestSessionMeta, SessionModelInfo } from "../../types.js";
import { SESSION_ID_RE } from "../../types.js";
import { modelLabel, contextWindowFor } from "../../menu-core/pure.js";

/**
 * Live (process-alive) sessions with their owning pid. Each
 * `~/.claude/sessions/<n>.json` records `{ sessionId, pid, ... }`; we keep
 * only those whose pid is still running. The pid lets a caller map a terminal
 * to its session by process ancestry (the agent's pid is a descendant of the
 * terminal's pty), which is the only reliable link when the session was
 * launched via `--continue` (no sessionId known up front).
 */
/**
 * Claude Code's config home — `$CLAUDE_CONFIG_DIR` when set (Claude Code honors it, so an isolated /
 * demo profile pointed there writes its sessions/projects/settings under it), else `~/.claude`. Every
 * session/model/title/effort read resolves through this so Jamat reads the SAME store Claude Code
 * writes. When the env var is unset (normal use) this is exactly `join(homeDir, ".claude")` — no-op.
 */
export function claudeConfigHome(homeDir: string = homedir()): string {
  const cc = process.env["CLAUDE_CONFIG_DIR"]?.trim();
  return cc ? cc : join(homeDir, ".claude");
}

export function listActiveSessionPids(): { pid: number; sessionId: string }[] {
  const sessDir = join(claudeConfigHome(), "sessions");
  const out: { pid: number; sessionId: string }[] = [];
  try {
    for (const f of readdirSync(sessDir)) {
      try {
        const data = JSON.parse(readFileSync(join(sessDir, f), "utf-8"));
        if (data.sessionId && data.pid) {
          try { process.kill(data.pid, 0); out.push({ pid: data.pid, sessionId: data.sessionId }); } catch { /* dead pid */ }
        }
      } catch { /* skip bad files */ }
    }
  } catch { /* no sessions dir */ }
  return out;
}

export function getActiveSessionIds(): Set<string> {
  return new Set(listActiveSessionPids().map((s) => s.sessionId));
}

export function pathToProjectDirName(folderPath: string): string {
  // Claude Code names its ~/.claude/projects/<dir> by replacing EVERY
  // non-alphanumeric char of the cwd with "-" (verified against real dirs:
  // "." -> "-", " " -> "-", "_" -> "-", path separators -> "-"). Match it
  // exactly. A partial replacement (only \ : /) silently fails to resolve any
  // project whose path contains "_", spaces or "." — e.g. an entire
  // "_"-prefixed category, where every project's sessions became invisible.
  return folderPath.replace(/[^A-Za-z0-9]/g, "-");
}

let projectDirCache: Map<string, string> | null = null;

function getProjectDirLookup(): Map<string, string> {
  if (projectDirCache) return projectDirCache;
  const claudeProjectsDir = join(claudeConfigHome(), "projects");
  projectDirCache = new Map();
  try {
    for (const d of readdirSync(claudeProjectsDir)) {
      projectDirCache.set(d.toLowerCase(), join(claudeProjectsDir, d));
    }
  } catch {}
  return projectDirCache;
}

export function invalidateProjectDirCache() {
  projectDirCache = null;
}

export function findProjectDir(folderPath: string): string | null {
  const expected = pathToProjectDirName(folderPath).toLowerCase();
  let hit = getProjectDirLookup().get(expected);
  // Self-heal a stale cache: a project whose ~/.claude/projects/<dir> folder
  // was created after this process built the cache (e.g. a Claude session
  // first started in the Electron app after launch) would never resolve.
  // On a miss, invalidate once and re-scan before giving up.
  if (!hit) {
    invalidateProjectDirCache();
    hit = getProjectDirLookup().get(expected);
  }
  return hit ?? null;
}

/**
 * Append a `custom-title` JSONL record to a session's transcript so the
 * next `loadSessionsForProject` / `findCustomTitle` call surfaces the new
 * name as the session's slug. Equivalent to what Claude Code's `/rename`
 * slash command writes — same line shape, same `findCustomTitle` reader.
 *
 * Returns true on success. False on invalid input (bad sessionId, empty
 * name, missing transcript) or fs error. Safe to call against running
 * sessions — the JSONL is append-only and the new line is independent of
 * any in-flight tool_use blocks.
 */
export function appendCustomTitleLine(
  jsonlPath: string,
  sessionId: string,
  customTitle: string,
): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  if (!existsSync(jsonlPath)) return false;
  // Collapse newlines, trim, cap length. A line with literal `\n` would
  // break the JSONL one-record-per-line contract.
  const safe = customTitle.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  if (!safe) return false;
  let line = JSON.stringify({ type: "custom-title", customTitle: safe, sessionId }) + "\n";
  try {
    // Guard the JSONL one-record-per-line contract: if a prior write left
    // the file without a trailing newline (mid-write, crash, truncation),
    // our record would fuse onto the previous one and corrupt that segment
    // (every future parse of it throws). Prepend a newline when needed.
    const size = statSync(jsonlPath).size;
    if (size > 0) {
      const fd = openSync(jsonlPath, "r");
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) line = "\n" + line;
      } finally {
        closeSync(fd);
      }
    }
    appendFileSync(jsonlPath, line, "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function findCustomTitle(filePath: string): string | null {
  const fd = openSync(filePath, "r");
  try {
    const chunkSize = 65536;
    const size = statSync(filePath).size;
    const readFrom = Math.max(0, size - chunkSize);
    const buf = Buffer.alloc(Math.min(chunkSize, size));
    readSync(fd, buf, 0, buf.length, readFrom);
    const text = buf.toString("utf-8");
    let lastTitle: string | null = null;
    const marker = '"type":"custom-title"';
    let pos = 0;
    while (true) {
      const idx = text.indexOf(marker, pos);
      if (idx === -1) break;
      const lineStart = text.lastIndexOf("\n", idx) + 1;
      const lineEnd = text.indexOf("\n", idx);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      try {
        const obj = JSON.parse(line);
        if (obj.customTitle) lastTitle = obj.customTitle;
      } catch {}
      pos = idx + marker.length;
    }
    return lastTitle;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function readFirstLines(filePath: string, maxLines: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const size = 131072;
    const buf = Buffer.alloc(size);
    const bytesRead = readSync(fd, buf, 0, size, 0);
    return buf.toString("utf-8", 0, bytesRead).split("\n").slice(0, maxLines).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

export function extractUserText(content: any): string | null {
  if (typeof content === "string") {
    if (content.length > 3 && !content.startsWith("<")) return content;
    return null;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string" && item.text.length > 3) {
        return item.text;
      }
    }
  }
  return null;
}

/**
 * Clean a user message for display in compact UI rows (session lists, preview
 * panes). Strips Claude Code's `[Image #N]` placeholders that appear when the
 * user pasted an image, collapses internal whitespace, trims, and truncates.
 * Without the strip+trim, leading placeholders or newlines show up as visible
 * indentation that breaks vertical alignment of adjacent rows.
 */
export function sanitizeUserMessage(text: string, maxLen: number): string {
  return text
    .replace(/\[Image\s*#?\d+\]/g, "") // Claude Code image-paste placeholders
    .replace(/\s+/g, " ")              // newlines + collapsed whitespace → single space
    .trim()
    .slice(0, maxLen);
}

export function loadSessionsForProject(projectDir: string): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  const activeIds = getActiveSessionIds();
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = join(projectDir, file);
    try {
      const lines = readFirstLines(filePath, 20);
      if (lines.length < 2) continue;

      let sessionId = "";
      let slug: string | null = null;
      let firstUserMessage: string | null = null;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
          if (obj.slug && !slug) slug = obj.slug;
          if (!firstUserMessage && obj.type === "user") {
            const text = extractUserText(obj.message?.content);
            if (text) {
              const cleaned = sanitizeUserMessage(text, 120);
              if (cleaned) firstUserMessage = cleaned;
            }
          }
        } catch { /* skip bad lines */ }
      }

      if (!sessionId) continue;
      const customTitle = findCustomTitle(filePath);
      if (customTitle) slug = customTitle;
      const fstat = statSync(filePath);
      const createdAt = fstat.birthtime;
      const lastActivity = fstat.mtime;
      sessions.push({ sessionId, slug, firstUserMessage, createdAt, lastActivity, active: activeIds.has(sessionId) });
    } catch { /* skip unreadable files */ }
  }

  return sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

export function loadSessionPreview(projectDir: string, sessionId: string): string[] {
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const messages: string[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user") {
          const text = extractUserText(obj.message?.content);
          if (text) {
            const cleaned = sanitizeUserMessage(text, 200);
            if (cleaned) {
              const ts = obj.timestamp ? new Date(obj.timestamp) : null;
              const dateStr = ts
                ? `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`
                : "";
              messages.push(`[${dateStr}] ${cleaned}`);
            }
          }
        }
      } catch { /* skip bad lines */ }
    }

    // Last 30 user messages, **newest first** — preview panels render row
    // 0 at the top, so reversing puts the most recent prompt at the top
    // (avoids showing the early-conversation "context-setting" prompts when
    // the panel only has a few rows of vertical space).
    return messages.slice(-30).reverse();
  } catch {
    return [];
  }
}

export function getLatestSessionMeta(folderPath: string): LatestSessionMeta | null {
  const projDir = findProjectDir(folderPath);
  if (!projDir) return null;
  try {
    let bestMtime = -1;
    let bestBirthtime: Date | null = null;
    let bestFile = "";
    for (const f of readdirSync(projDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const s = statSync(join(projDir, f));
      if (s.mtimeMs > bestMtime) {
        bestMtime = s.mtimeMs;
        bestBirthtime = s.birthtime;
        bestFile = f;
      }
    }
    if (bestMtime < 0 || !bestBirthtime) return null;
    let label: string | null = null;
    if (bestFile) {
      const filePath = join(projDir, bestFile);
      const customTitle = findCustomTitle(filePath);
      if (customTitle) {
        label = customTitle;
      } else {
        const lines = readFirstLines(filePath, 20);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.slug && !label) { label = obj.slug; break; }
            if (!label && obj.type === "user") {
              const text = extractUserText(obj.message?.content);
              if (text) {
                const cleaned = sanitizeUserMessage(text, 120);
                if (cleaned) label = cleaned;
              }
            }
          } catch {}
        }
      }
    }
    return { createdAt: bestBirthtime!, lastActivity: new Date(bestMtime), label };
  } catch {
    return null;
  }
}

/**
 * Resolve the transcript .jsonl for a running session in `folderPath`.
 * Prefers an explicit sessionId; otherwise picks the most-recently-written
 * jsonl whose session is still alive (falling back to the newest overall).
 */
export function resolveActiveSessionFile(
  folderPath: string,
  sessionId?: string | null
): string | null {
  const projDir = findProjectDir(folderPath);
  if (!projDir) return null;

  if (sessionId && SESSION_ID_RE.test(sessionId)) {
    const p = join(projDir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }

  let files: string[];
  try {
    files = readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const active = getActiveSessionIds();
  let best: { path: string; mtime: number } | null = null;
  let bestActive: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const p = join(projDir, f);
    let mtime: number;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { path: p, mtime };
    if (active.has(f.slice(0, -6)) && (!bestActive || mtime > bestActive.mtime)) {
      bestActive = { path: p, mtime };
    }
  }
  return (bestActive ?? best)?.path ?? null;
}

/**
 * Read the model + current context size from a transcript's last assistant
 * turn. Scans the file tail (assistant lines are frequent, so the latest is
 * effectively always within the final chunk); widens once if not found.
 */
export function readSessionModelInfo(jsonlPath: string): SessionModelInfo | null {
  let fd: number;
  try {
    fd = openSync(jsonlPath, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(jsonlPath).size;
    if (size === 0) return null;
    // Post-compact size: a `system`/`compact_boundary` record newer than the last real assistant
    // turn carries the TRUE post-compact context in `compactMetadata.postTokens`. Captured while
    // scanning the tail backward (it sits just after the now-stale pre-compact turn) and used to
    // override the count below, so the indicator/overlay reflect the compact IMMEDIATELY instead of
    // holding the old near-full value until the next real turn is written. A real assistant turn
    // that lands AFTER the compact is met first (newer) → this stays null → its fresh usage wins.
    let postCompactTokens: number | null = null;
    for (const chunkSize of [262144, 1048576]) {
      const readFrom = Math.max(0, size - chunkSize);
      const len = Math.min(chunkSize, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, readFrom);
      const lines = buf.toString("utf-8").split("\n");
      // When not starting at byte 0 the first line is likely truncated — skip it.
      const start = readFrom > 0 ? 1 : 0;
      for (let i = lines.length - 1; i >= start; i--) {
        const line = lines[i];
        if (!line) continue;
        // Compact boundary (checked before the model filter — this record carries no `model`).
        // Only meaningful while no real assistant turn has been found yet going backward, i.e. the
        // compact is the most recent event; remember its postTokens and override the count below.
        if (postCompactTokens === null && line.indexOf('"compact_boundary"') !== -1) {
          try {
            const pt = JSON.parse(line)?.compactMetadata?.postTokens;
            if (typeof pt === "number" && pt >= 0) postCompactTokens = pt;
          } catch { /* partial line — ignore, a wider chunk re-scans it */ }
          continue;
        }
        if (line.indexOf('"model"') === -1) continue;
        try {
          const obj = JSON.parse(line);
          const msg = obj?.message;
          if (obj?.type !== "assistant" || !msg?.model || !msg?.usage) continue;
          // Claude Code writes a `model:"<synthetic>"` assistant turn for local-only
          // interactions (a fresh session before its first API turn, /context, /compact,
          // an interrupted turn, bridge-driven sessions). It carries no real model/window
          // and usually zero usage — picking it would mislabel the model as "<synthetic>"
          // and, via the 200k window fallback, inflate the context % ~5x (firing the
          // compact nag far too early). Skip it and keep scanning back for the last REAL
          // (`claude-…`) turn; a session with ONLY synthetic turns yields null (indicator
          // hidden until the first real turn).
          if (!/^claude-/i.test(msg.model)) continue;
          const u = msg.usage;
          const usageTokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          return {
            model: msg.model,
            modelLabel: modelLabel(msg.model),
            // Model/window come from this (pre-compact) turn — the boundary record carries neither;
            // the token COUNT is overridden by the post-compact size when a compact is the newest event.
            contextTokens: postCompactTokens ?? usageTokens,
            contextWindow: contextWindowFor(msg.model),
            effortLevel: null, // filled in by the caller via readEffortLevel
          };
        } catch {
          /* partial or non-JSON line — skip */
        }
      }
      if (readFrom === 0) break; // whole file already scanned
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve Claude Code's effort level for a project, in Claude Code's
 * documented precedence order (most specific wins):
 *   1. <projectDir>/.claude/settings.local.json
 *   2. <projectDir>/.claude/settings.json
 *   3. <homeDir>/.claude/settings.json
 * Returns the first non-empty `effortLevel` string found, or null.
 */
export function readEffortLevel(projectDir: string, homeDir: string): string | null {
  const candidates = [
    join(projectDir, ".claude", "settings.local.json"),
    join(projectDir, ".claude", "settings.json"),
    join(claudeConfigHome(homeDir), "settings.json"),
  ];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const obj = JSON.parse(readFileSync(path, "utf-8"));
      const v = obj?.effortLevel;
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      /* malformed JSON — fall through to next candidate */
    }
  }
  return null;
}

const EDITED_FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const editedFilesCache = new Map<
  string,
  { mtimeMs: number; size: number; parsedOffset: number; files: string[]; seen: Set<string> }
>();

/**
 * Absolute paths of files the session actually modified, in first-seen order.
 * Scans every `tool_use` entry for Edit/Write/NotebookEdit and pulls
 * `input.file_path` — this surfaces files edited *outside* the session's cwd
 * (e.g. a DEUSS session editing ida-backend). Result is cached per transcript
 * and only re-parsed when the .jsonl grows or its mtime changes.
 */
export function extractSessionEditedFiles(jsonlPath: string): string[] {
  let st: { mtimeMs: number; size: number };
  try {
    const s = statSync(jsonlPath);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return [];
  }
  const cached = editedFilesCache.get(jsonlPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.files;
  }

  // The transcript is APPEND-ONLY. When it only grew (an active session keeps writing),
  // parse JUST the newly-appended tail since the last fully-parsed line — NOT the whole
  // file. The old code re-read + re-parsed the ENTIRE (multi-MB, ever-growing) .jsonl on
  // every change; RecentFilesPanel polls this every few seconds, so a long active session
  // froze the app with an O(filesize) re-parse that got worse as the session grew. Reading
  // only the appended bytes makes the per-poll cost O(bytes appended), independent of length.
  const canExtend = !!cached && st.size > cached.parsedOffset;
  const files: string[] = canExtend ? cached!.files.slice() : [];
  const seen: Set<string> = canExtend ? new Set(cached!.seen) : new Set();
  const startOffset = canExtend ? cached!.parsedOffset : 0;
  let parsedOffset = startOffset;

  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const len = st.size - startOffset;
      if (len > 0) {
        const buf = Buffer.allocUnsafe(len);
        const read = readSync(fd, buf, 0, len, startOffset);
        // Parse only up to the LAST newline — a trailing partial line (a write in flight) is
        // left for the next poll; parsedOffset advances only to that newline boundary.
        const lastNl = read > 0 ? buf.lastIndexOf(0x0a, read - 1) : -1;
        if (lastNl !== -1) {
          parsedOffset = startOffset + lastNl + 1;
          const text = buf.toString("utf-8", 0, lastNl + 1);
          for (const line of text.split("\n")) {
            if (!line || line.indexOf('"tool_use"') === -1) continue;
            let obj: { type?: string; message?: { content?: unknown } };
            try {
              obj = JSON.parse(line);
            } catch {
              continue; // partial or non-JSON line
            }
            if (obj.type !== "assistant") continue;
            const items = obj.message?.content;
            if (!Array.isArray(items)) continue;
            for (const it of items) {
              if (
                it?.type !== "tool_use" ||
                !EDITED_FILE_TOOLS.has(it.name) ||
                typeof it.input?.file_path !== "string"
              ) {
                continue;
              }
              const fp: string = it.input.file_path;
              const key = fp.replace(/\\/g, "/").toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              files.push(fp);
            }
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return cached?.files ?? [];
  }

  editedFilesCache.set(jsonlPath, { mtimeMs: st.mtimeMs, size: st.size, parsedOffset, files, seen });
  return files;
}

export function buildSessionMetaCache(catPath: string, folderNames: string[]): Map<string, LatestSessionMeta> {
  const cache = new Map<string, LatestSessionMeta>();
  for (const name of folderNames) {
    const meta = getLatestSessionMeta(join(catPath, name));
    if (meta) cache.set(name, meta);
  }
  return cache;
}
