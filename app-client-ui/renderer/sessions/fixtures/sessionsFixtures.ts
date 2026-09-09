import type { ProjectBinding } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  SessionInfo,
  SessionsSnapshot,
  SessionTitleParts,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/**
 * The recorded snapshots, typed rather than JSON for the reason `launcherFixtures.ts` gives: a
 * fixture cast into the wire type goes on compiling after that type has moved, and the tests below
 * would then be checking a shape the library no longer has.
 *
 * What they hold is mostly what only reconciliation produces - a record whose runtime is gone, an
 * install that failed, a Host nobody can reach - which is exactly what nobody would think to write
 * again by hand, and exactly what has to fail loudly when the wire changes under it.
 */
export class SessionsFixtures {
  private static readonly jamatConst = 'C:/Projects/NodeJs/AppJamatV3'
  private static readonly webAdminConst = 'C:/Projects/Web/WebJamatAdmin'

  /** Categories in catalog order, both worktree badge shapes, ad-hoc, no-project, an orphan. */
  static mixed(): SessionsSnapshot {
    return {
      revision: 7,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '2026.08.04.09.30',
        hostInstanceId: 'host-a',
        liveCount: 4,
        lastStartError: null,
      },
      categories: [
        { id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' },
        { id: 'web', label: 'Web', path: 'C:/Projects/Web' },
      ],
      sessions: [
        {
          sessionId: 's-lost',
          kind: 'agent',
          ...SessionsFixtures.titled('Lost claude'),
          tabTitle: 'WebJamatAdmin - Lost claude',
          ...SessionsFixtures.inProject('web', 'WebJamatAdmin', SessionsFixtures.webAdminConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-lost' },
          life: 'lost',
          outcome: 'interrupted',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'restart', 'remove'],
          endedReason: 'no runtime answered for this record',
        },
        {
          // Stopped, which is what finishes a session with it: the mark rides along with the stop.
          // It is the only thing keeping this row out of the daily view - `s-ended` beside it ended
          // on its own, carries no mark, and is therefore still unfinished business.
          sessionId: 's-done',
          kind: 'agent',
          ...SessionsFixtures.titled('Finished claude'),
          tabTitle: 'WebJamatAdmin - Finished claude',
          ...SessionsFixtures.inProject('web', 'WebJamatAdmin', SessionsFixtures.webAdminConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-done' },
          life: 'ended',
          outcome: 'finished',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'restart', 'remove'],
          endedAt: 1754300500000,
          exitCode: 0,
          completed: true,
        },
        {
          // Drawn by its tab alone: the tree shows it only under a scope that asks for tabs.
          sessionId: 's-tab',
          kind: 'agent',
          ...SessionsFixtures.titled('Scratch tab'),
          tabTitle: 'AppJamatV3 - Scratch tab',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'codex' },
          presentation: 'tab',
          life: 'live',
          activity: 'idle',
          // No id of its own yet, so nothing to fork and nothing a reopen could name.
          admits: ['newBeside', 'compact', 'finalize'],
        },
        {
          sessionId: 's-ended',
          kind: 'agent',
          ...SessionsFixtures.titled('Ended codex'),
          tabTitle: 'WebJamatAdmin - Ended codex',
          ...SessionsFixtures.inProject('web', 'WebJamatAdmin', SessionsFixtures.webAdminConst),
          agent: { agentId: 'codex', nativeSessionId: 'native-ended' },
          life: 'ended',
          outcome: 'failed',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'restart', 'remove'],
          endedAt: 1754200500000,
          exitCode: 1,
        },
        {
          sessionId: 's-working',
          kind: 'agent',
          ...SessionsFixtures.titled('Alpha worktree'),
          tabTitle: 'AppJamatV3 - Alpha worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-working' },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/alpha`,
            branch: 'feature/alpha',
            baseCommit: 'aa11bb22',
            diff: { added: 12, removed: 3, changedFiles: 4, capturedAt: 1754310000000 },
            baseMoved: true,
          },
          life: 'live',
          activity: 'working',
          admits: ['newBeside', 'fork', 'compact', 'restart', 'finalize'],
        },
        {
          sessionId: 's-waiting',
          kind: 'agent',
          ...SessionsFixtures.titled('Beta worktree'),
          tabTitle: 'AppJamatV3 - Beta worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'codex', nativeSessionId: 'native-waiting' },
          // Nothing has measured this one yet, which is not the same as no changes.
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/beta`,
            branch: 'feature/beta',
            baseCommit: 'cc33dd44',
            diff: null,
            baseMoved: false,
          },
          life: 'live',
          activity: 'waiting',
          admits: ['newBeside', 'fork', 'compact', 'restart', 'finalize'],
        },
        {
          sessionId: 's-shell',
          kind: 'shell',
          ...SessionsFixtures.titled('Gamma shell'),
          tabTitle: 'AppJamatV3 - Gamma shell',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          life: 'live',
          activity: null,
          // A shell has no conversation to name, so resuming it is never in doubt; the three agent
          // operations mean nothing here.
          admits: ['restart', 'finalize'],
        },
        {
          sessionId: 's-adhoc',
          kind: 'shell',
          ...SessionsFixtures.titled('Scratch shell'),
          tabTitle: 'Scratch - Scratch shell',
          directory: { mode: 'adHoc', path: 'Q:/Scratch' },
          project: { kind: 'adHoc', path: 'Q:/Scratch' },
          life: 'live',
          activity: null,
          admits: ['restart', 'finalize'],
        },
        {
          // The same directory as the one above, written the way the other tool wrote it.
          sessionId: 's-adhoc-cased',
          kind: 'shell',
          ...SessionsFixtures.titled('Scratch shell two'),
          tabTitle: 'Scratch - Scratch shell two',
          directory: { mode: 'adHoc', path: 'q:\\Scratch\\' },
          project: { kind: 'adHoc', path: 'q:\\Scratch\\' },
          life: 'ended',
          outcome: 'finished',
          activity: null,
          admits: ['restart', 'remove'],
          endedAt: 1754307500000,
          exitCode: 0,
        },
        {
          sessionId: 's-home',
          kind: 'agent',
          ...SessionsFixtures.titled('Home claude'),
          tabTitle: 'Terminal - Home claude',
          directory: { mode: 'default' },
          project: { kind: 'none' },
          agent: { agentId: 'claude' },
          life: 'starting',
          activity: 'unknown',
          // Starting belongs to the reconciler, so restarting it under that is not offered.
          admits: ['newBeside', 'finalize', 'remove'],
        },
      ],
      orphans: [{ runtimeSessionId: 'orphan-1', alive: true, startedAt: 1754290000000 }],
    }
  }

  /** A session waiting on its install, the install session itself, and an ended neighbour. */
  static setupPending(): SessionsSnapshot {
    return {
      revision: 3,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '2026.08.04.09.30',
        hostInstanceId: 'host-a',
        liveCount: 2,
        lastStartError: null,
      },
      categories: [{ id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }],
      sessions: [
        {
          sessionId: 's-primary',
          kind: 'agent',
          ...SessionsFixtures.titled('Alpha worktree'),
          tabTitle: 'AppJamatV3 - Alpha worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-primary' },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/alpha`,
            branch: 'feature/alpha',
            baseCommit: 'aa11bb22',
            diff: null,
            baseMoved: false,
          },
          life: 'starting',
          activity: 'unknown',
          // Its install is still running, and that flow owns the record until it decides - which is
          // why there is no `restart` here. `remove` there is: a `starting` record with no runtime
          // on the Host is exactly the session that could once be neither started nor deleted.
          admits: ['newBeside', 'fork', 'finalize', 'remove'],
          setup: { state: 'running', setupSessionId: 's-install', commands: ['pnpm install'] },
        },
        {
          // The install carries the worktree as its DIRECTORY and no worktree field of its own,
          // which is what the session manager writes; the binding still resolves to the project.
          sessionId: 's-install',
          kind: 'shell',
          ...SessionsFixtures.titled('Setup alpha'),
          tabTitle: 'AppJamatV3 - Setup alpha',
          directory: { mode: 'adHoc', path: `${SessionsFixtures.jamatConst}/.worktrees/alpha` },
          project: SessionsFixtures.boundTo('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          life: 'live',
          activity: null,
          // An install session is another flow's, and restarting it would restart that flow's step.
          admits: ['finalize'],
          setupFor: 's-primary',
        },
        {
          sessionId: 's-neighbour',
          kind: 'shell',
          ...SessionsFixtures.titled('Zulu shell'),
          tabTitle: 'AppJamatV3 - Zulu shell',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          life: 'ended',
          outcome: 'finished',
          activity: null,
          admits: ['restart', 'remove'],
          endedAt: 1754319000000,
          exitCode: 0,
        },
      ],
      orphans: [],
    }
  }

  /** The two outcomes an install can leave behind: skipped, and failed with its install session. */
  static setupOutcomes(): SessionsSnapshot {
    return {
      revision: 4,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '2026.08.04.09.30',
        hostInstanceId: 'host-a',
        liveCount: 1,
        lastStartError: null,
      },
      categories: [{ id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }],
      sessions: [
        {
          sessionId: 's-skipped',
          kind: 'agent',
          ...SessionsFixtures.titled('Alpha worktree'),
          tabTitle: 'AppJamatV3 - Alpha worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-skipped' },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/alpha`,
            branch: 'feature/alpha',
            baseCommit: 'aa11bb22',
            diff: { added: 0, removed: 0, changedFiles: 0, capturedAt: 1754330000000 },
            baseMoved: false,
          },
          life: 'live',
          activity: 'idle',
          // A skipped install left a marker, not a wait: nothing is holding this record.
          admits: ['newBeside', 'fork', 'compact', 'restart', 'finalize'],
          setup: { state: 'skipped', reason: 'the project declares no setup steps' },
        },
        {
          sessionId: 's-failed',
          kind: 'agent',
          ...SessionsFixtures.titled('Beta worktree'),
          tabTitle: 'AppJamatV3 - Beta worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'codex', nativeSessionId: 'native-failed' },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/beta`,
            branch: 'feature/beta',
            baseCommit: 'cc33dd44',
            diff: null,
            baseMoved: false,
          },
          life: 'ended',
          outcome: 'failed',
          activity: 'unknown',
          // The failed wait stays on the record, which is what `retrySetup` works from: restarting
          // past it would launch the agent into a worktree nobody installed.
          admits: ['newBeside', 'fork', 'remove', 'discardWorktree', 'retrySetup'],
          endedAt: 1754331000000,
          endedReason: 'the setup session exited with 1',
          setup: { state: 'failed', setupSessionId: 's-failed-install', commands: ['pnpm install'] },
        },
        {
          sessionId: 's-failed-install',
          kind: 'shell',
          ...SessionsFixtures.titled('Setup beta'),
          tabTitle: 'AppJamatV3 - Setup beta',
          directory: { mode: 'adHoc', path: `${SessionsFixtures.jamatConst}/.worktrees/beta` },
          project: SessionsFixtures.boundTo('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          life: 'ended',
          outcome: 'failed',
          activity: null,
          admits: ['remove'],
          endedAt: 1754330950000,
          exitCode: 1,
          setupFor: 's-failed',
        },
      ],
      orphans: [],
    }
  }

  /** Stopped worktrees whose remaining decision is asked by the finalize dialog. */
  static stoppedWorktree(): SessionsSnapshot {
    return {
      revision: 11,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '2026.08.19.10.00',
        hostInstanceId: 'host-a',
        liveCount: 0,
        lastStartError: null,
      },
      categories: [{ id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }],
      sessions: [
        {
          sessionId: 's-dirty',
          kind: 'agent',
          ...SessionsFixtures.titled('Dirty worktree'),
          tabTitle: 'AppJamatV3 - Dirty worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-dirty' },
          vcs: { vcsId: 'git', dirty: true },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/dirty`,
            branch: 'jamat/dirty',
            baseCommit: 'cc33dd44',
            diff: null,
            baseMoved: false,
          },
          life: 'ended',
          // Stopped: the kill code says nothing, and the verdict is what the row reads.
          outcome: 'finished',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'restart', 'finalize', 'remove', 'discardWorktree'],
          endedAt: 1754400500000,
          exitCode: -1073741510,
        },
        {
          sessionId: 's-clean',
          kind: 'agent',
          ...SessionsFixtures.titled('Clean worktree'),
          tabTitle: 'AppJamatV3 - Clean worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-clean' },
          vcs: { vcsId: 'git', dirty: false },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/clean`,
            branch: 'jamat/clean',
            baseCommit: 'ee55ff66',
            diff: null,
            baseMoved: false,
          },
          life: 'ended',
          outcome: 'finished',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'restart', 'finalize', 'remove', 'discardWorktree'],
          endedAt: 1754400600000,
          exitCode: -1073741510,
        },
      ],
      orphans: [],
    }
  }

  /**
   * The three states a merge can be caught in, which nothing else here carried: one still running,
   * one stopped on conflicts with the resolver it minted running underneath it, and one that
   * failed. Until 2026-08-21 no fixture had a `merge` field at all, so the row's merge word, its
   * `data-merge` attribute and the nesting of a resolver under the session it resolves for were
   * drawn by code no test ever ran.
   */
  static merging(): SessionsSnapshot {
    return {
      revision: 13,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '2026.08.21.08.00',
        hostInstanceId: 'host-a',
        liveCount: 1,
        lastStartError: null,
      },
      categories: [{ id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }],
      sessions: [
        {
          sessionId: 's-merging',
          kind: 'agent',
          ...SessionsFixtures.titled('Bravo worktree'),
          tabTitle: 'AppJamatV3 - Bravo worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-merging' },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/bravo`,
            branch: 'jamat/bravo',
            baseCommit: 'ee55ff66',
            diff: null,
            baseMoved: false,
          },
          merge: { phase: 'base-merging', startedAt: 1754500000000 },
          life: 'ended',
          outcome: 'finished',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'finalize', 'remove', 'discardWorktree'],
          endedAt: 1754500000000,
          exitCode: 0,
        },
        {
          sessionId: 's-conflicted',
          kind: 'agent',
          ...SessionsFixtures.titled('Charlie worktree'),
          tabTitle: 'AppJamatV3 - Charlie worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-conflicted' },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/charlie`,
            branch: 'jamat/charlie',
            baseCommit: 'aa77bb88',
            diff: null,
            baseMoved: false,
          },
          merge: {
            phase: 'resolving',
            startedAt: 1754500100000,
            resolveSessionId: 's-resolver',
          },
          life: 'ended',
          outcome: 'finished',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'finalize', 'remove'],
          endedAt: 1754500100000,
          exitCode: 0,
        },
        {
          // The resolver: a fork of the session above, running INSIDE its worktree, which the tree
          // nests under it exactly as it nests an install under the session it prepares.
          sessionId: 's-resolver',
          kind: 'agent',
          ...SessionsFixtures.titled('Resolve merge jamat/charlie'),
          tabTitle: 'AppJamatV3 - Resolve merge jamat/charlie',
          directory: { mode: 'adHoc', path: `${SessionsFixtures.jamatConst}/.worktrees/charlie` },
          project: SessionsFixtures.boundTo('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-resolver' },
          life: 'live',
          activity: 'working',
          admits: ['finalize'],
          resolveFor: 's-conflicted',
        },
        {
          sessionId: 's-merge-failed',
          kind: 'agent',
          ...SessionsFixtures.titled('Delta worktree'),
          tabTitle: 'AppJamatV3 - Delta worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-merge-failed' },
          worktree: {
            worktreePath: `${SessionsFixtures.jamatConst}/.worktrees/delta`,
            branch: 'jamat/delta',
            baseCommit: 'cc99dd00',
            diff: null,
            baseMoved: false,
          },
          merge: {
            phase: 'resolving',
            startedAt: 1754500300000,
            resolveSessionId: 's-gone',
            failure: 'the resolver finished and the conflict is still there',
          },
          life: 'ended',
          outcome: 'finished',
          activity: 'unknown',
          admits: ['newBeside', 'fork', 'finalize', 'remove'],
          endedAt: 1754500300000,
          exitCode: 0,
        },
      ],
      orphans: [],
    }
  }

  static hostUnreachable(): SessionsSnapshot {
    return {
      revision: 9,
      reconciled: true,
      host: {
        presence: 'unreachable',
        hostVersion: null,
        hostInstanceId: null,
        liveCount: 0,
        lastStartError: 'the Host did not answer on the descriptor port',
      },
      categories: [{ id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }],
      sessions: [
        {
          sessionId: 's-working',
          kind: 'agent',
          ...SessionsFixtures.titled('Alpha worktree'),
          tabTitle: 'AppJamatV3 - Alpha worktree',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          agent: { agentId: 'claude', nativeSessionId: 'native-working' },
          life: 'live',
          activity: 'working',
          // What a session admits comes off its record, so an unreachable Host does not change it.
          // Whether the operation then succeeds is the operation's own answer.
          admits: ['newBeside', 'fork', 'compact', 'restart', 'finalize'],
        },
        {
          sessionId: 's-shell',
          kind: 'shell',
          ...SessionsFixtures.titled('Gamma shell'),
          tabTitle: 'AppJamatV3 - Gamma shell',
          ...SessionsFixtures.inProject('nodejs', 'AppJamatV3', SessionsFixtures.jamatConst),
          life: 'live',
          activity: null,
          admits: ['restart', 'finalize'],
        },
        {
          sessionId: 's-home',
          kind: 'agent',
          ...SessionsFixtures.titled('Home claude'),
          tabTitle: 'Terminal - Home claude',
          directory: { mode: 'default' },
          project: { kind: 'none' },
          agent: { agentId: 'claude' },
          life: 'starting',
          activity: 'unknown',
          admits: ['newBeside', 'finalize', 'remove'],
        },
      ],
      orphans: [],
    }
  }

  /**
   * A title and the parts the library would split it into. Spelled here rather than computed - the
   * renderer program types the library `import type` only - which is honest for these fixtures
   * because none of their titles carries a numeric prefix.
   */
  private static titled(title: string): { title: string; titleParts: SessionTitleParts } {
    return { title, titleParts: { number: null, name: title } }
  }

  /** Where a session in a catalog project sits: what it was asked for, and what it bound to. */
  private static inProject(
    categoryId: string,
    projectName: string,
    projectPath: string,
  ): { directory: SessionInfo['directory']; project: ProjectBinding } {
    return {
      directory: { mode: 'project', categoryId, projectPath },
      project: SessionsFixtures.boundTo(categoryId, projectName, projectPath),
    }
  }

  private static boundTo(
    categoryId: string,
    projectName: string,
    projectPath: string,
  ): ProjectBinding {
    return { kind: 'project', categoryId, projectName, projectPath }
  }
}
