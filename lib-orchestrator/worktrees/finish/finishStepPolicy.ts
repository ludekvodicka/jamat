import type { FinishStep } from '../worktreeState'

export class FinishStepPolicy {
  static requiresApproval(step: FinishStep | undefined): boolean { return step === 'awaiting-idle' || step === 'committing' }
  static readonly steps: Record<FinishStep, { background: boolean; prepare: boolean; verdict: boolean }> = {
    syncing: { background: true, prepare: false, verdict: true },
    'worker-resolving': { background: true, prepare: false, verdict: true },
    checking: { background: true, prepare: true, verdict: true },
    reviewing: { background: false, prepare: true, verdict: false },
    'awaiting-idle': { background: true, prepare: false, verdict: false },
    committing: { background: true, prepare: false, verdict: true },
    verifying: { background: true, prepare: false, verdict: false },
    disposing: { background: true, prepare: false, verdict: false },
    'stopping-worker': { background: true, prepare: false, verdict: false },
    removing: { background: true, prepare: false, verdict: false },
    recording: { background: true, prepare: false, verdict: false },
  }
}
