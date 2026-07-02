/**
 * Agent registry IPC. The renderer needs the available-agents list for the
 * TabTypePicker (to grey out unavailable backends) but can't call
 * `listAvailableAgents()` directly because it touches `existsSync` /
 * `process.env.PATH` — the renderer runs under sandbox+contextIsolation
 * where neither is reachable.
 */

import { homedir } from 'os'
import { listAgents, listAvailableAgents, resolveAgentForSessionId } from '../../../core/agents/index.js'
import { SESSION_ID_RE } from '../../../core/types/contracts.js'
import { registerHandler } from '../shared/typed-ipc'

export function registerAgentIpc(): void {
  registerHandler('agents:list', async () => {
    const available = new Set(listAvailableAgents().map((a) => a.id))
    return listAgents().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      binary: a.binary,
      available: available.has(a.id),
    }))
  })

  registerHandler('agents:resolve-for-session', async (_e, sessionId) => {
    // Guard against path-traversal probes: only canonical UUID sessionIds
    // ever reach `findSessionFileById` (which builds `join(root, projDir,
    // <id>.jsonl)` and `existsSync` — would otherwise act as an oracle).
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
    return resolveAgentForSessionId(sessionId, homedir())
  })
}
