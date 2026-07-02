/**
 * Jamat scenario catalog — pure metadata (electron-free, fs-free). The single
 * source of truth for which scenarios exist, shared by:
 *  - the local gateway's `GET /jamat/help` manifest (`ai-gateway.ts`),
 *  - the orchestrator/registry (`scenarios.ts`, which attaches the strategy fns),
 *  - the teaching skill's reference.
 *
 * Each scenario is a composition of the 4 phases (Deliver / Trigger / Await /
 * Read); `—` means the phase is a no-op for that scenario.
 */

export type ScenarioId = 'issue-handoff' | 'terminal-task' | 'consult' | 'notify' | 'unblock'

export interface ScenarioMeta {
  id: ScenarioId
  summary: string
  /** Human-readable phase composition (for the manifest + skill docs). */
  phases: { deliver: string; trigger: string; await: string; read: string }
}

export const JAMAT_SCENARIOS: readonly ScenarioMeta[] = [
  {
    id: 'issue-handoff',
    summary: 'Delegate a task via an issue tracker; the remote AI answers in an issue comment.',
    phases: {
      deliver: 'local AI creates the issue (its own issue-tracker skill, --repo)',
      trigger: 'write-keys: "process issue #N, answer in the issue"',
      await: 'poll the issue for an answer comment (issue-tracker skill); status = liveness',
      read: 'the answer comment (issue-tracker skill)',
    },
  },
  {
    id: 'terminal-task',
    summary: 'Ask the remote AI to do X and answer in its terminal.',
    phases: {
      deliver: '—',
      trigger: 'write-keys: the task + the answer marker instruction',
      await: 'turn-detection (prompt-idle / 15s) + the answer fence in the delta',
      read: 'scrollback delta since the trigger cursor (sinceSeq)',
    },
  },
  {
    id: 'consult',
    summary: 'Read-only: peek a remote tab to see what it is doing / stuck on. No injection.',
    phases: { deliver: '—', trigger: '—', await: '—', read: 'scrollback snapshot' },
  },
  {
    id: 'notify',
    summary: 'Fire-and-forget: send the remote AI a one-way message; no answer awaited.',
    phases: { deliver: '—', trigger: 'write-keys: the message', await: '—', read: '—' },
  },
  {
    id: 'unblock',
    summary: "Answer a remote AI that is blocked on a question, then read the result.",
    phases: {
      deliver: '—',
      trigger: 'write-keys: the answer to the blocked prompt',
      await: 'status leaves blocked, then turn-detection',
      read: 'scrollback delta since the trigger cursor',
    },
  },
]
