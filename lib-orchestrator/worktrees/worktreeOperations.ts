import { JournaledConflictResolutions } from './conflicts/journaledConflictResolutions'
import type { SvnWorktreeManager } from '../svn/svnWorktreeManager'
import { SvnConflictFlow } from './conflicts/svnConflictFlow'
import { SvnResolverLauncher } from './conflicts/svnResolverLauncher'
import { FinishDriver } from './finish/finishDriver'
import type { FinishDriverDeps, FinishDriverPorts } from './finish/finishDriver.types'
import type { SvnActionFlowDeps } from './finish/svnActionFlow'
import { SyncStep } from './finish/syncStep'
import { WorkerReady } from './finish/workerIdle'
import { MainCopyUpdate } from './landing/mainCopyUpdate'
import { SvnCheckoutStep } from './provision/svnCheckoutStep'
import { SvnStepRunner, type SvnStepRunnerDeps } from './svnStepRunner'
import type { WorktreeSvnCommands } from './worktreeSvnCommands'

export interface WorktreeOperationsDeps extends Pick<SvnStepRunnerDeps, 'records' | 'scripts' | 'now' | 'newId' | 'changed'>,
  Pick<FinishDriverDeps, 'results' | 'handoffs' | 'busyReason' | 'holdInput'> {
  svn: SvnWorktreeManager
  commands: WorktreeSvnCommands
  resolver: SvnActionFlowDeps['resolver']
}

export class WorktreeOperations {
  readonly ready: WorkerReady
  readonly runner: SvnStepRunner
  readonly sync: SyncStep
  readonly checkout: SvnCheckoutStep
  readonly resolutions: JournaledConflictResolutions

  constructor(deps: WorktreeOperationsDeps) {
    this.ready = new WorkerReady(deps.records, deps.svn, deps.commands)
    this.runner = new SvnStepRunner({ ...deps, svn: deps.commands, lease: deps.commands.lease })
    this.resolutions = new JournaledConflictResolutions({ records: deps.records, svn: deps.svn, commands: deps.commands, runner: this.runner,
      now: deps.now, markersIn: (root, paths) => SvnResolverLauncher.markersIn(root, paths) })
    const conflicts = new SvnConflictFlow({ svn: deps.svn, briefs: deps.resolver.briefs, handover: deps.results,
      savedDirectoryOf: (id) => deps.results.savedDirectoryOf(id), resolutions: this.resolutions,
      withMarkers: deps.resolver.withMarkers, unavailable: deps.resolver.unavailable, cli: deps.resolver.cli, now: deps.now })
    this.sync = new SyncStep({ ...deps, runner: this.runner, ready: this.ready, conflicts })
    this.checkout = new SvnCheckoutStep({ records: deps.records, runner: this.runner, svn: deps.svn, now: deps.now })
  }

  static finish(actions: SvnActionFlowDeps, ports: FinishDriverPorts): FinishDriver {
    const update = new MainCopyUpdate({ ...actions, lease: ports.commands.lease, commands: ports.commands })
    return new FinishDriver({ ...actions, ...ports, update })
  }
}
