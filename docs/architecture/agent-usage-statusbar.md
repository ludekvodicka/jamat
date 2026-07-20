# Agent-aware rate limits in the status bar

## Decision

The Electron status bar shows account rate limits only for the agent running in the active local
terminal. It never shows local account data in a project menu, shell, settings/statistics panel, or
remote viewer.

Claude and Codex retain their native authentication and data sources. The renderer receives one
normalized provider snapshot and does not know either source protocol.

## Normalized contract

`core/types/session.ts` defines:

```ts
interface UsageWindow {
  durationMinutes: number
  usedPercent: number
  resetsAt: string | null
}

interface AgentUsageSnapshot {
  agent: AgentId
  fetchedAt: number
  windows: UsageWindow[]
  error?: string
}
```

`usage:get(agent)` reads one provider. `usage:update` broadcasts one snapshot and the renderer stores
it under `snapshot.agent`, preventing Claude values from appearing in a Codex tab or vice versa.

## Provider sources

| Agent | Source | Authentication | Refresh |
|---|---|---|---|
| Claude | `claude.ai/api/organizations/<id>/usage` | Existing organization ID and session cookie | Existing ten-minute disk cache/poll |
| Codex | Codex app-server `account/rateLimits/read` and `account/rateLimits/updated` | Existing Codex login | Immediate activation read plus one-minute active-tab poll |

The Codex client is a lazy main-process JSONL stdio client. It performs the app-server
`initialize`/`initialized` handshake, associates responses with request IDs, tolerates interleaved
notifications, times out failed requests, and retries once with a fresh child process. It is stopped
with the usage manager and never writes credentials or Codex-owned files.

Codex limit roles follow `windowDurationMins`, not `primary`/`secondary` position:

| Duration | Status label |
|---:|---|
| 300 minutes | `S` |
| 10080 minutes | `W` |

`rateLimitsByLimitId.codex` takes precedence over compatibility and model-specific buckets. Missing
windows are not invented: a weekly-only Codex response renders only `W`; an unusable Codex snapshot
renders `W:?`, never a false `S:` value.

## Visibility and ordering

The main process publishes `screen:update-params` before `screen:phase = running`. The renderer first
records the validated panel agent and then exposes the running phase, so a rapid Claude/Codex switch
cannot briefly render the previous provider.

`AgentUsageStatus` selects an agent only when all three conditions hold:

1. the active Dockview component is `terminalPanel`;
2. its volatile terminal phase is `running`;
3. its mirrored agent value passes `isAgentId`.

The phase and agent maps are keyed by panel ID, are not persisted in Dockview layouts, and are cleared
when the terminal is disposed. Undefined transition state and every other component stay hidden.

## Key files

- `core/agents/codex/rateLimits.ts` — pure duration-based response normalization
- `app-electron/src/main/codex-rate-limit-client.ts` — Codex app-server lifecycle
- `app-electron/src/main/usage-manager.ts` — provider dispatch, caching, errors, and broadcasts
- `core/types/ipc-contracts.ts` — agent-aware IPC contract
- `app-electron/src/renderer/hooks/useTerminal.ts` — authoritative phase mirror
- `app-electron/src/renderer/components/panels/TerminalSidebarPanel.tsx` — validated agent mirror
- `app-electron/src/renderer/components/AgentUsageStatus.tsx` — visibility, polling, and rendering

The Codex app-server protocol is owned by the installed Codex version. Keep the client tolerant and
re-run the mapper/client checks after upgrades.
