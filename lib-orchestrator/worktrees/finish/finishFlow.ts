import type { FinishStep, WorktreeLifecycle } from '../worktreeState'

export type FinishStepExecutor = (sessionId: string, state: WorktreeLifecycle) => Promise<boolean>
export type FinishStepExecutors = Readonly<Record<FinishStep, FinishStepExecutor>>

export class FinishFlow {
  private readonly read: (sessionId: string) => WorktreeLifecycle | undefined
  private readonly steps: FinishStepExecutors
  private readonly before: (sessionId: string, state: WorktreeLifecycle) => Promise<void>

  constructor(read: FinishFlow['read'], steps: FinishStepExecutors, before: FinishFlow['before']) {
    this.read = read
    this.steps = steps
    this.before = before
  }

  async advance(sessionId: string): Promise<'waiting' | 'yield'> {
    for (let count = 0; count < 32; count++) {
      const prior = this.read(sessionId)
      if (!FinishFlow.runnable(prior)) return 'waiting'
      await this.before(sessionId, prior)
      const state = this.read(sessionId)
      if (!FinishFlow.runnable(state) || state.step === undefined) return 'waiting'
      const execute = Object.hasOwn(this.steps, state.step) ? this.steps[state.step] : undefined
      if (execute === undefined) throw new Error(`Unknown Finish step: ${state.step}`)
      const version = state.version
      if (!await execute(sessionId, state)) return 'waiting'
      const after = this.read(sessionId)
      if (after !== undefined && after.version <= version)
        throw new Error(`Finish step ${state.step} continued without saving progress`)
    }
    return 'yield'
  }

  private static runnable(state: WorktreeLifecycle | undefined): state is WorktreeLifecycle {
    return state !== undefined && (state.phase === 'finishing'
      || state.step === 'worker-resolving' && state.wait?.kind === 'worker-lost')
  }
}
