/**
 * The classifier's vocabulary, ported from AppJamat (V1) `core/agents/workDetection/
 * agentWorkDetector.types.ts`. What did not come across is everything about streaming: the callbacks,
 * the scheduler, the timer ladder and the status/report/verdict shapes they published. Here an
 * inspection is a value read from one frame, and the passage of time is the monitor's business.
 *
 * Data only - no `node:` import, no runtime code - so both inspectors and the monitor can name these
 * shapes freely.
 */

/**
 * What one frame looks like. `blocked` is a permission prompt and `waiting` a question menu; both
 * mean a person has to answer, which is why the monitor maps them to the same activity.
 *
 * `background` is current-screen evidence that work started by the turn remains alive: Claude's
 * task footer or Codex's background-terminal wait. The turn may be over, but the session is working
 * and its row is green. It is its own hint rather than a second kind of `working` because the two
 * age differently - see the evidence clock in `WorkStateMonitor.apply`.
 */
export type AgentWorkHint =
  'working' | 'idle' | 'tool-use' | 'blocked' | 'waiting' | 'background' | 'unknown'

/** Which of the three windows a match was found in. */
export type AgentWorkEvidenceSource = 'raw' | 'screen' | 'wide-screen'

export interface AgentWorkEvidence {
  source: AgentWorkEvidenceSource
  signal: string
  match: string
}

/**
 * The windows a verdict is read from. V1 carried a `phase` here as well, telling the detector that
 * its terminal was showing V1's own menu rather than an agent; a runtime in this tree is the agent
 * and nothing else, so the field has no meaning and is gone.
 */
export interface AgentWorkFrame {
  rawTail: string
  screenTail: string
  wideScreenTail: string
}

export interface AgentWorkInspection {
  hint: AgentWorkHint
  evidence: readonly AgentWorkEvidence[]
}
