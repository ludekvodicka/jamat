export interface VirtualFolderDef {
  prefix: string;
  title: string;
}

export interface ProjectEntry {
  name: string;
  usageCount: number;
  lastUsed: string | null;
}

export type SortMode = "usage" | "recent" | "alpha";

export type DisplayEntry =
  | { kind: "folder"; name: string; displayName: string }
  | { kind: "virtual"; prefix: string; title: string; count: number };

function isUpper(ch: string): boolean {
  return ch.length === 1 && ch >= "A" && ch <= "Z";
}

export function matchesVirtualPrefix(name: string, prefix: string): boolean {
  if (name.length <= prefix.length || !name.startsWith(prefix)) return false;
  const lastPrefixChar = prefix[prefix.length - 1];
  if (lastPrefixChar === "-" || lastPrefixChar === "_") return true;
  return isUpper(name[prefix.length]);
}

export function stripVirtualPrefix(name: string, prefix: string): string {
  return name.slice(prefix.length);
}

export function sortProjectEntries(projects: ProjectEntry[], sortMode: SortMode): ProjectEntry[] {
  return [...projects].sort((a, b) => {
    if (sortMode === "alpha") {
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    if (sortMode === "recent") {
      const lastA = a.lastUsed || "";
      const lastB = b.lastUsed || "";
      if (lastB !== lastA) return lastB.localeCompare(lastA);
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    // "usage"
    const countA = a.usageCount || 0;
    const countB = b.usageCount || 0;
    if (countB !== countA) return countB - countA;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function buildDisplayEntries(
  folderNames: string[],
  virtualFolders: VirtualFolderDef[],
  currentVirtualPrefix: string | null,
  virtualFoldersEnabled: boolean = true
): DisplayEntry[] {
  if (!virtualFoldersEnabled || virtualFolders.length === 0) {
    return folderNames.map((f) => ({ kind: "folder", name: f, displayName: f }));
  }

  if (currentVirtualPrefix) {
    return folderNames
      .filter((f) => matchesVirtualPrefix(f, currentVirtualPrefix))
      .map((f) => ({
        kind: "folder" as const,
        name: f,
        displayName: stripVirtualPrefix(f, currentVirtualPrefix),
      }));
  }

  const matched = new Set<string>();
  const virtualEntries: Array<{ kind: "virtual"; prefix: string; title: string; count: number }> = [];
  for (const vf of virtualFolders) {
    const inGroup = folderNames.filter((f) => matchesVirtualPrefix(f, vf.prefix));
    inGroup.forEach((f) => matched.add(f));
    if (inGroup.length > 0) {
      virtualEntries.push({
        kind: "virtual",
        prefix: vf.prefix,
        title: vf.title,
        count: inGroup.length,
      });
    }
  }

  virtualEntries.sort((a, b) => a.title.localeCompare(b.title));

  const regular: DisplayEntry[] = folderNames
    .filter((f) => !matched.has(f))
    .map((f) => ({ kind: "folder" as const, name: f, displayName: f }));

  return [...virtualEntries, ...regular];
}

// ── Model identity helpers ──
//
// Claude Code transcripts store the model as a bare id like "claude-opus-4-7"
// (no "[1m]" tier suffix), so the context window is inferred from the family.
// Assumption for this account: Opus/Sonnet 4.x run on the 1M-token tier; Haiku → 200k.
// An UNRECOGNISED id (e.g. "<synthetic>") returns 0 so callers hide the indicator
// rather than guess a window and inflate the context %. Adjust the map if a tier changes.

const CONTEXT_1M = 1_000_000;
const CONTEXT_200K = 200_000;

/** "claude-opus-4-7" → "Opus 4.7". Falls back to the raw id when unrecognised. */
export function modelLabel(modelId: string): string {
  if (!modelId) return "unknown";
  const id = modelId.replace(/\[1m\]$/i, "");
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/i);
  if (!m) return modelId;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}.${m[3]}`;
}

/** Max context window in tokens, inferred from the model family. 0 = unknown (caller hides). */
export function contextWindowFor(modelId: string): number {
  if (/\[1m\]$/i.test(modelId)) return CONTEXT_1M;
  const fam = modelId.match(/^claude-([a-z]+)-/i)?.[1]?.toLowerCase();
  if (fam === "opus" || fam === "sonnet") return CONTEXT_1M;
  if (fam === "haiku") return CONTEXT_200K;
  return 0; // unrecognised id (e.g. "<synthetic>") — don't guess a window
}

export function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function formatDuration(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}min`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDays < 30) return `${diffDays}d`;
  const months = diffDays / 30.44;
  return `${months.toFixed(1)}m`;
}
