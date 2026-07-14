/**
 * Electron binding for the persistent update log (`core/update/update-log-store.ts` holds the logic;
 * this only supplies the path). Writes are BEST-EFFORT: a failing log must never break an update flow,
 * so every error is swallowed after one `logError`.
 */
import { appendUpdateLog, readUpdateLogTail, type UpdateLogEntry } from '../../../../core/update/update-log-store.js'
import { getJamatPaths } from '../jamat-paths'
import { logError, logInfo } from '../logger'

export type { UpdateLogEntry }

export function logUpdate(entry: Omit<UpdateLogEntry, 'ts'>): void {
  logInfo('update', `${entry.event}${entry.channel ? ` [${entry.channel}]` : ''}${entry.reason ? ` — ${entry.reason}` : ''}`)
  try {
    appendUpdateLog(getJamatPaths().updateLog, entry)
  } catch (e) {
    logError('update', `update-log write failed: ${(e as Error)?.message ?? String(e)}`)
  }
}

export function readLogTail(maxEntries?: number): UpdateLogEntry[] {
  try {
    return readUpdateLogTail(getJamatPaths().updateLog, maxEntries)
  } catch {
    return []
  }
}
