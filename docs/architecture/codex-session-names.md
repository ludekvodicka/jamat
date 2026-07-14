# Codex session names

## Decision

Jamat treats Codex's `~/.codex/session_index.jsonl` as the durable compatibility surface for
explicit session names. It does not derive a renamed title from the rollout and never writes
Claude's `custom-title` record into a Codex transcript.

Current Codex stores one JSON object per name update:

```json
{"id":"<session UUID>","thread_name":"codexUI","updated_at":"<RFC 3339 timestamp>"}
```

The file is append-only. Duplicate IDs are expected and the last valid row wins. Malformed rows are
ignored. A missing or empty latest name means the session has no explicit title.

This behavior was verified against `codex-cli 0.144.4` and the official Codex implementation in
`codex-rs/rollout/src/session_index.rs`. The official CLI also supports `/rename <name>` and updates
its other internal metadata through that native path.

## Reading and caching

`core/agents/codex/threadNames.ts` owns the index format. It parses forward into a map so later rows
replace earlier ones, and caches the map by index file mtime and size. A missing file yields an empty
map. Appending through Jamat invalidates the cache immediately.

The Codex session picker sets `SessionInfo.slug` from this map. Existing fallbacks remain unchanged:
an unnamed session shows its first normalized human prompt, then its UUID if no prompt exists.

`CodexAdapter.getSessionTitle()` derives the Codex home and session UUID from the canonical rollout
path, then resolves the name through the same owner. This keeps picker and tab semantics identical.

## Live Electron tab synchronization

Title watching is adapter-owned:

| Agent | Watched file | Title reader |
|---|---|---|
| Claude | `<project-storage>/<sessionId>.jsonl` | latest `custom-title` transcript row |
| Codex | `~/.codex/session_index.jsonl` | latest `thread_name` row for the session UUID |

`screen-executor.ts` asks the adapter for this watch target. `fs.watch` triggers a debounced title
read, while the existing 2.5-second poll remains the fallback. A renamed tab is composed as
`<folderName> - <title>`.

## F2 rename

For a tab with a known session UUID, F2 performs two operations:

1. `sessions:rename` resolves the real rollout through the owning adapter and appends the native
   durable title record.
2. The renderer sends `/rename <name>` to the live Codex PTY so Codex updates its TUI and internal
   metadata.

For a brand-new Codex tab whose UUID has not been resolved yet, F2 sends only the native slash
command and updates the tab optimistically. Once the rollout appears, the no-pid resolver records its
UUID and invalidates discovery so subsequent title reads and F2 operations target that exact session.

Jamat does not edit Codex's SQLite state. The native slash command owns that implementation detail;
the append-only index is the compatibility and fallback layer.

## Key files and verification

- `core/agents/codex/threadNames.ts` — index parser, cache, append, watch path.
- `core/agents/codex/sessions.ts` — picker slug and latest-session metadata.
- `core/agents/codex/index.ts` — adapter title and rename methods.
- `app-electron/src/main/screen-executor.ts` — live title watcher and poller.
- `app-electron/src/main/ipc-sessions.ts` — adapter-routed durable rename.
- `app-electron/src/renderer/components/layout/CustomTab.tsx` — F2 native slash synchronization.
- `scripts/smoke-codex-sessions.ts` and `scripts/smoke-agents-registry.ts` — latest-wins,
  malformed-row, newline, watch-target, capability, and slash regressions.
