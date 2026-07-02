/**
 * Remote Activity Log — the shared sink for every *discrete* remote-control
 * action (human via the UI or AI via the bridge, either side). It:
 *   1. pushes to the unified ring (`app-state`),
 *   2. streams the entry to the renderer's Remote Activity Log tab
 *      (`remote:activity` IPC — the hook auto-opens that tab inactive), and
 *   3. when the entry carries an `action` (i.e. it's a discrete op, not an AI
 *      progress phase), appends it to a durable per-day JSONL audit.
 *
 * Kept separate from `app-state` (which stays electron-free to avoid the
 * control-server ↔ ipc-windows import cycle) because it needs `electron` + `fs`.
 * Imported by control-server (controlled side), remote-client (controller, human)
 * and ai-gateway (controller, AI) — so all three log through ONE path.
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { publish } from './streams'
import { logError } from './logger'
import { getJamatPaths } from './jamat-paths'
import { pushRemoteActivity } from './app-state'
import { getRemoteControl } from './remote-control-store'
import type { RemoteActivityEntry } from '../../../core/types/remote-control.js'

const RETENTION_DAYS = 30

export function recordRemoteActivity(entry: RemoteActivityEntry): void {
  pushRemoteActivity(entry)
  publish('remote:activity', entry)
  // Discrete actions (those with an `action`) form the durable audit trail; AI
  // progress phases (no `action`, live narration only) are not persisted.
  if (entry.action) persist(entry)
}

function persist(entry: RemoteActivityEntry): void {
  void (async () => {
    try {
      const dir = getJamatPaths().remoteActivityDir
      await fsp.mkdir(dir, { recursive: true })
      const day = new Date(entry.ts).toISOString().slice(0, 10)
      await fsp.appendFile(join(dir, `${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf-8')
    } catch (err) {
      try { logError('remote-activity', `persist failed: ${err}`) } catch { /* ignore */ }
    }
  })()
}

/**
 * One-shot startup retention sweep. Both the persisted audit (`remote-activity/
 * *.jsonl`) and the delegated-task drop dir (`.jamat-tasks/*.md`,
 * incl. `*.answer.md`) are append-only and otherwise unbounded — a busy machine
 * (human + AI) grows them indefinitely. Deletes files whose mtime is older than
 * RETENTION_DAYS. Best-effort: missing dirs and per-file errors are ignored.
 */
export function sweepRetention(): void {
  void (async () => {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const activityDir = getJamatPaths().remoteActivityDir
    const taskDir = join(getRemoteControl().bridgeScratchDir || homedir(), '.jamat-tasks')
    await Promise.all([
      sweepDir(activityDir, /\.jsonl$/, cutoff),
      sweepDir(taskDir, /\.md$/, cutoff),
    ])
  })()
}

async function sweepDir(dir: string, match: RegExp, cutoff: number): Promise<void> {
  let names: string[]
  try { names = await fsp.readdir(dir) } catch { return } // dir may not exist yet
  for (const name of names) {
    if (!match.test(name)) continue
    const p = join(dir, name)
    try {
      const st = await fsp.stat(p)
      if (st.mtimeMs < cutoff) await fsp.unlink(p)
    } catch { /* ignore per-file */ }
  }
}
