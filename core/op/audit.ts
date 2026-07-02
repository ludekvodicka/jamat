/**
 * One audit sink for op dispatch — the accountability record under the single-key model (no per-op
 * authz, so "who did what" lives here). In-memory ring + a listener hook (the controlled side wires
 * `recordRemoteActivity` to it in P5). Dispatch logs every FAILURE (incl. reach/dev denials — security
 * signal) and every SUCCESS of an `audit:'discrete'` op; poll/per-keystroke ops don't flood.
 */

export interface AuditEntry {
  ts: number
  via: string
  corrId: string
  op: string
  ok: boolean
  rw?: string
  machine?: string
  note?: string
}

const RING: AuditEntry[] = []
const MAX = 2000
type Listener = (e: AuditEntry) => void
const listeners = new Set<Listener>()

export function recordAudit(e: Omit<AuditEntry, 'ts'>): void {
  const entry: AuditEntry = { ts: Date.now(), ...e }
  RING.push(entry)
  if (RING.length > MAX) RING.shift()
  for (const l of listeners) {
    try { l(entry) } catch { /* a broken listener must not break dispatch */ }
  }
}

export function auditTail(n = 200): AuditEntry[] {
  return RING.slice(-Math.max(0, n))
}

export function onAudit(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
