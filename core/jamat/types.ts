/**
 * Jamat scenario abstraction (pure). A Scenario is a composition of up to 4
 * phases the orchestrator runs in order: Deliver → Trigger → Await → Read. Each
 * phase is optional — a scenario implements only the ones it needs (e.g. consult
 * = read-only; notify = trigger-only). New scenario types register without
 * touching the orchestrator.
 */

import type { PeerRef } from './http.js'
import type { ScenarioId } from './scenarios-meta.js'

export type ScenarioOutcome = 'answered' | 'blocked' | 'idle' | 'sent' | 'peeked' | 'timeout' | 'error'

/** One audit/log line the gateway forwards to the Jamat Log tab. No secrets. */
export interface BridgeLogEntry {
  ts: number
  corrId: string
  /** Absent for non-scenario actions (wake, tabs listing). */
  scenario?: ScenarioId
  peer: string
  terminalId?: string
  phase: 'preflight' | 'deliver' | 'trigger' | 'await' | 'read' | 'result' | 'info'
  message: string
}

/** Mutable context threaded through a scenario's phases. */
export interface ScenarioCtx {
  peer: PeerRef
  terminalId: string
  /** Task / message / blocked-answer text (scenario-dependent). */
  task: string
  corrId: string
  /** S1 only: the issue-tracker repo + issue the local AI already created (for the trigger prompt). */
  repo?: string
  issue?: number
  /** Await budget + poll cadence for terminal scenarios. */
  maxWaitMs: number
  pollMs: number
  // ── scratch the phases fill ──
  /** `seq` cursor captured just before the trigger, so the delta is exactly the new output. */
  seqAtTrigger?: number
  /** The harvested answer (terminal) or snapshot (consult). */
  answer?: string
  /** True when the answer overflowed the peer's 256 KB ring. */
  truncated?: boolean
  /** Emit a log line (forwarded to the Jamat Log tab). ts/corrId/scenario/peer filled by the orchestrator. */
  log: (phase: BridgeLogEntry['phase'], message: string) => void
}

export interface Scenario {
  id: ScenarioId
  /** Stage the task somewhere the remote can pick up (currently unused — the issue work is done by the local AI's skill). */
  deliver?(ctx: ScenarioCtx): Promise<void>
  /** Kick the remote AI (write-keys). */
  trigger?(ctx: ScenarioCtx): Promise<void>
  /** Wait for the turn to finish; returns the terminal outcome. */
  awaitTurn?(ctx: ScenarioCtx): Promise<{ outcome: ScenarioOutcome }>
  /** Produce the result text (answer / snapshot). */
  read?(ctx: ScenarioCtx): Promise<string>
}

export interface ScenarioResult {
  ok: boolean
  scenario: ScenarioId
  outcome: ScenarioOutcome
  corrId: string
  /** Answer text (terminal scenarios) or the peeked snapshot (consult). UNTRUSTED remote output. */
  data?: string
  truncated?: boolean
  error?: string
}
