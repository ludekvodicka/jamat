/**
 * The agent's API gate predicate — the single source of truth for which routes require the machine
 * key. Side-effect-free (no server, no import of the self-starting agent-server) so it is
 * unit-testable (scripts/smoke-agent-gate.ts). Every `/api/*` route EXCEPT the keyless
 * `/api/health` reachability probe is gated behind the machine key (plan 002 P5b).
 */
export function isGatedApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') && pathname !== '/api/health'
}
