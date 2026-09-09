import type { HostCallErrorCode, HostCallFailure } from '../../hostClient/hostClient.types'
import type { RuntimeRef } from '../../../app-host/app/wire/hostWire.js'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionsOpErrorCode } from '../sessionManagerApi.types'
import type { SessionDirectoryRef } from '../records/sessionRecord.types'

/**
 * What an OPERATION on a session answers, and how a Host failure is read.
 *
 * Named for the operation rather than the session, because `records/sessionOutcomes.ts` answers a
 * different question about the same word: how a session ENDED, read off the record it left behind.
 * This one is about the call somebody just made.
 *
 * Pure, and shared by the three classes that decide a session's fate: the lifecycle, the setup flow
 * and the reconciler's applier. They were private statics of the lifecycle while it was the only
 * one, and carving the setup machine out is what made "shared" true rather than incidental. Nothing
 * here holds state or reaches the Host - each is a question about a value somebody already has.
 */
export class OperationOutcomes {
  /** Git's codes, carried verbatim through a mapping for the same reason as the Host client's. */
  /**
   * Whether the Host DECIDED this launch, which is what decides the fate of a pending record. Only
   * a refusal a retry cannot change is a decision; everything else leaves the record pending, which
   * is what the reconciler replays under the same operation id.
   *
   * `host-unreachable` never reached the Host. `no-lease` is refused inside the Host client before
   * anything is sent, so the launch definitively did not run. Neither is a decision, and both keep
   * the pending record.
   *
   * `op-rejected` is classified by the status the Host answered with, because one code covers two
   * completely different things:
   *
   * | 400 | the request itself - a cwd that does not exist, a malformed id | DECISION: the same body never becomes valid |
   * | 404 | no such op, or no such runtime on this Host | DECISION: this Host has nothing to address |
   * | 409 | the Host is stopping, the lease lapsed between its two checks, a generation moved, a recorded operation is no longer current | retry: every one of them is a state, and states change |
   * | 429 | the live-runtime ceiling (the Host's `SessionManager.maxLiveConst`) | retry: a runtime exits and the ceiling lifts |
   * | 401, 403 | the token belongs to a descriptor, and a restarted Host publishes a new one | retry: the watcher is already fetching it |
   * | 5xx | the Host's own fault, including the transport's catch-all | retry: nothing about the request was judged |
   * | 2xx | an answer this client could not read | retry: a success it could not parse means the launch may well have run |
   *
   * 409 is the load-bearing one and it goes with HTTP's own reading: a conflict is with the current
   * state of the target, and a client is expected to resolve it and resubmit. Two of the 409s the
   * Host really sends - the shutdown and the lapsed lease - are transient by construction, and the
   * price of the classification is the opposite case: a create the Host's operation ledger refuses
   * for good is retried until that Host restarts. Ending the record instead is a session killed for
   * ever, with the worktree and the branch still on disk and the slug refused to whoever tries it
   * again - so it is paced rather than ended: `LaunchBackoff` counts the refusals, spaces the
   * replays and, once enough of them stand, is what lets the row say it is waiting. Retrying once
   * per reconcile pass for ever is what this classification cost before that existed, measured on
   * 2026-09-05 at 885 rejected creates in nine minutes over four sessions nobody could close.
   */
  static decided(failure: HostCallFailure): boolean {
    if (failure.code === 'host-unreachable' || failure.code === 'no-lease') return false
    else if (failure.code === 'op-rejected')
      return failure.status === 400 || failure.status === 404
    else throw new Error(`Unknown Host call failure: ${JSON.stringify(failure)}`)
  }

  static failureOf(
    result: { code: HostCallErrorCode; detail: string },
  ): { ok: false; code: SessionsOpErrorCode; detail: string } {
    return { ok: false, code: OperationOutcomes.codeOf(result.code), detail: result.detail }
  }

  /**
   * The refusal a write that landed nowhere gets, and it says exactly that much: THIS write recorded
   * nothing and left the file alone. It deliberately claims nothing about the rest of the call - a
   * refused write is the only thing the store answers for, and what a call had already done before
   * it is the call's own to say. The two create paths below had cut a worktree, so they say so.
   */
  static latched(): { ok: false; code: SessionsOpErrorCode; detail: string } {
    return {
      ok: false,
      code: 'records-latched',
      detail: 'The session records could not be written, so this change was not recorded; the file '
        + 'was left as this write found it, and why the write failed is on the error channel',
    }
  }

  static notFound(sessionId: string): { ok: false; code: SessionsOpErrorCode; detail: string } {
    return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
  }

  /** Only a project directory ever reaches a worktree; `specProblem` is what makes that true. */
  static projectRootOf(directory: SessionDirectoryRef): string {
    if (directory.mode === 'project') return directory.projectPath
    throw new Error(`A worktree spec passed validation without a project directory: ${
      JSON.stringify(directory)}`)
  }

  static targetOf(record: SessionRecord): RuntimeRef | null {
    if (!record.binding) return null
    return {
      hostInstanceId: record.binding.hostInstanceId,
      runtimeSessionId: record.sessionId,
      generation: record.binding.generation,
    }
  }

  /**
   * The Host client's codes are carried verbatim, the way git's and hostControl's are. The mapping
   * still exists rather than being a cast: it is what fails loudly the day the client learns a
   * fourth way to fail.
   */
  static codeOf(code: HostCallErrorCode): SessionsOpErrorCode {
    if (code === 'host-unreachable') return 'host-unreachable'
    else if (code === 'no-lease') return 'no-lease'
    else if (code === 'op-rejected') return 'op-rejected'
    else throw new Error(`Unknown Host call failure: ${JSON.stringify(code)}`)
  }
}
