import type { RemoteActivityEntry } from '../../../core/types/remote-control.js'

let restarting = false

export function getIsRestarting(): boolean { return restarting }
export function setIsRestarting(value: boolean): void { restarting = value }

// ── Remote Activity Log: ONE unified ring (human + AI, both sides) ──
// Lives here (the neutral module both `control-server` and `ipc-windows` may
// import) to avoid the documented control-server ↔ ipc-windows import cycle.
// This single ring backs both the renderer panel and the localhost
// `GET /debug/remote-activity-log` endpoint (so an AI can verify each action it
// calls produced an entry without reading the UI). The push+IPC-emit+JSONL
// wrapper is `recordRemoteActivity` in `remote-activity.ts` — it needs electron +
// fs, kept out of this otherwise-pure module.
const ACTIVITY_CAP = 500
const activityRing: RemoteActivityEntry[] = []

export function pushRemoteActivity(entry: RemoteActivityEntry): void {
  activityRing.push(entry)
  if (activityRing.length > ACTIVITY_CAP) activityRing.shift()
}

export function getRemoteActivityLog(): RemoteActivityEntry[] {
  return [...activityRing]
}

