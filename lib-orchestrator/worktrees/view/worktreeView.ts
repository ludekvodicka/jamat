import { WorktreeWords } from './worktreeWords'
import type { WorktreeView } from '../../sessionManager/sessionManagerApi.types'
import type { WorktreeLifecycle } from '../worktreeState'

export class WorktreeViews {
  static of(state: WorktreeLifecycle | undefined): WorktreeView | undefined {
    if (state === undefined) return undefined
    return { ...WorktreeWords.presentation(state), version: state.version, phase: state.phase, ...state.step === undefined ? {} : { step: state.step },
      ...state.wait === undefined ? {} : { wait: { ...state.wait } }, outOfDate: state.outOfDate,
      conflicts: state.conflictMemory?.paths.length ?? 0,
      summary: `${state.phase}${state.step === undefined ? '' : `/${state.step}`} v${state.version}` }
  }
}
