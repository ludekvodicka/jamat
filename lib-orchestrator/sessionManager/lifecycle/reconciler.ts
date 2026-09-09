import type { RuntimeListResult, RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import { CodexIdCapture } from '../launch/codexIdCapture'
import type { SessionExitReason, SessionRecord } from '../records/sessionRecord.types'
import { LaunchBackoff } from './launchBackoff'

export type ReconcileChange =
  | { kind: 'bind-live'; sessionId: string; binding: { hostInstanceId: string; generation: number } }
  /**
   * `exitReason` is the Host's own word for the ending, carried through to the record. The type is
   * mirrored rather than imported, and `exitReasonOf` holds both halves of that mirror: an assignment
   * the build checks, and a comparison the run checks against a Host that is simply newer.
   */
  | {
    kind: 'mark-ended'
    sessionId: string
    exitCode?: number
    exitReason?: SessionExitReason
    endedAt: number
  }
  | { kind: 'mark-lost'; sessionId: string }
  /**
   * A launch that never got its answer, to be replayed under the id it was started with. `operation`
   * is what the record was asking for: a create replays the create's command line, a reopen the
   * resume it had already chosen.
   */
  | {
    kind: 'retry-launch'
    sessionId: string
    operationId: string
    operation: 'create' | 'reopen'
  }
  | { kind: 'orphan'; runtimeSessionId: string }
  /**
   * The setup session finished cleanly, so the launch that was waiting for it can run. `sessionId`
   * is the PRIMARY session's, never the setup's: the setup is the evidence, not the subject.
   */
  | { kind: 'setup-succeeded'; sessionId: string }
  /**
   * The setup failed, or there is no longer anything to say it succeeded. The primary session ends
   * with this reason; its worktree, its branch and its link to the setup session all stay.
   */
  | { kind: 'setup-failed'; sessionId: string; reason: string }
  /**
   * The session resolving a merge conflict exited cleanly, so the merge can carry on from whatever
   * it left in the worktree. `sessionId` is the PRIMARY session's, as with the setup pair.
   */
  | { kind: 'merge-resolve-succeeded'; sessionId: string }
  /** The resolver did not finish cleanly. The phase stays, so the manual path is still open. */
  | { kind: 'merge-resolve-failed'; sessionId: string; reason: string }
  /**
   * A live Codex session that has never named the conversation it is having. Codex takes no id
   * before it starts, so the only place one exists is the rollout it has just written; this says to
   * look for it, and looking is all it says - the apply side may find nothing, twice over, and that
   * is a normal answer rather than a failure.
   */
  | { kind: 'name-codex-conversation'; sessionId: string }

/**
 * The one place that decides what a session's record should say. It is pure - records and the Host's
 * answer in, changes out - so every state this library has to survive can be tested as plain data.
 */
export class Reconciler {
  /**
   * How long a live Codex session keeps being asked what conversation it is having on regular passes.
   *
   * The rollout appears a second or two after launch, so this is retry cadence rather than the last
   * moment its id can be found. A startup pass catches sessions missed here against the same fixed
   * launch window. Asking on the pass's own clock keeps this cadence free of another timer or state.
   */
  private static readonly codexNameWindowMillisecondsConst = 300_000

  /**
   * Runs on every (re)connect, on a new `hostInstanceId`, and after every `runtime-*` event.
   *
   * `now` is the lifecycle's own clock, which is what the applied changes are then judged against:
   * one of them is a window over the record's age, and a planner deciding it from the wall clock
   * while the capture behind it reads an injected one would disagree with itself. The default is for
   * the tests that do not care which moment it is.
   */
  static plan(
    records: readonly SessionRecord[],
    listing: RuntimeListResult | null,
    now: number = Date.now(),
  ): ReconcileChange[] {
    // Unreachable is NOT lost. Without an answer the records keep saying what they last knew, and
    // nothing is relabelled: a client that cannot see the Host has learnt nothing about a session.
    if (listing === null)
      return []
    const live = new Map(listing.sessions.map((session) => [session.runtimeSessionId, session]))
    const changes: ReconcileChange[] = []
    // FIRST, and over every record rather than only the live ones: a session whose merge is being
    // resolved is `ended` almost by definition - it was stopped before the merge could start - so
    // the loop below would skip exactly the records this judgement is about.
    for (const record of records) {
      const merge = record.worktreeMerge
      if (merge?.phase !== 'resolving' || merge.resolveSessionId === undefined) continue
      // A failure already written is a judgement already made; judging again every two seconds
      // would rewrite the same record for ever.
      if (merge.failure !== undefined) continue
      const judged = Reconciler.resolveJudgement(
        record.sessionId,
        merge.resolveSessionId,
        records,
        live,
      )
      if (judged) changes.push(judged)
    }
    for (const record of records) {
      if (record.life !== 'live' && record.life !== 'starting') continue
      const found = live.get(record.sessionId)
      /*
       * The gate, and it stands in front of every general rule below. A `starting` record whose own
       * launch is waiting for a setup session is judged by that setup and by nothing else: replaying
       * it would start the session in a worktree whose dependencies are still being installed, which
       * is the whole reason the setup exists, and losing it would throw away a session that has an
       * install running behind it.
       *
       * A record whose OWN runtime the Host does have falls through to the general rules on purpose.
       * The Host is the authority over what is running, so a runtime that exists anyway beats what
       * the record says it is waiting for - and binding or ending it clears `pendingSetup` on the
       * way past, which is how a record stops waiting for a setup that no longer decides anything.
       *
       * The pending pair is required for the same reason it is required below: without it no
       * judgement can start anything, and a wait nothing can end is a session that never moves,
       * silently, on every pass for ever. Nothing here writes that shape - the pair and the wait are
       * written together - but this file comes back off disk, where the store checks the shape of
       * each field and no invariant across two of them. So it falls through instead, and the rule
       * below reads it for what it is: starting, no runtime, no launch it can name. That is lost.
       */
      if (record.life === 'starting' && record.pendingSetup
        && record.pendingOperationId && record.pendingOperationKind && !found) {
        const judged = Reconciler.setupJudgement(
          record.sessionId,
          record.pendingSetup.setupSessionId,
          records,
          live,
        )
        if (judged) changes.push(judged)
        continue
      }
      if (!found) {
        // The Host answered and does not have it. A launch that crashed between the record write and
        // the Host's answer replays the SAME operationId, which the Host itself dedupes. Both halves
        // of the pending pair are required: an id with no kind cannot say which launch to repeat, so
        // the record is lost rather than replayed as a guess.
        if (record.life === 'starting' && record.pendingOperationId && record.pendingOperationKind
          && !Reconciler.isOrphanedSetup(record, records)) {
          // A Host that has refused this launch already sets the pace for the next attempt. Skipping
          // the pass rather than dropping the record is the whole point: the record stays pending and
          // is replayed the moment its wait is up, which is what a refusal that lifts deserves.
          if (LaunchBackoff.due(record.launchWait, now))
            changes.push({
              kind: 'retry-launch',
              sessionId: record.sessionId,
              operationId: record.pendingOperationId,
              operation: record.pendingOperationKind,
            })
        }
        else
          changes.push({ kind: 'mark-lost', sessionId: record.sessionId })
      }
      else if (!found.alive)
        changes.push({
          kind: 'mark-ended',
          sessionId: record.sessionId,
          exitCode: found.exitCode,
          exitReason: Reconciler.exitReasonOf(found.exitReason),
          endedAt: found.exitedAt ?? now,
        })
      else {
        // The Host is the authority over a live runtime: a differing generation or hostInstanceId
        // overwrites the stored binding, never the other way round.
        changes.push({
          kind: 'bind-live',
          sessionId: record.sessionId,
          binding: { hostInstanceId: listing.hostInstanceId, generation: found.generation },
        })
        if (Reconciler.wantsCodexName(record, now))
          changes.push({ kind: 'name-codex-conversation', sessionId: record.sessionId })
      }
    }
    const known = new Set(records.map((record) => record.sessionId))
    for (const session of listing.sessions)
      if (session.alive && !known.has(session.runtimeSessionId))
        changes.push({ kind: 'orphan', runtimeSessionId: session.runtimeSessionId })
    return changes
  }

  /**
   * An install is worth launching only while the session it names is still waiting for THIS one.
   *
   * `mintSetup` and `rearmSetup` write the install record first and arm the waiting record second,
   * which is the right order - it is what stops a waiting record ever pointing at a setup that is
   * already condemned - but it leaves a state on disk between the two writes: an install `starting`
   * under its own pending pair, and an owner that still names the OLD install or none at all. The
   * general rule above reads that install as a launch that never reached the Host and runs it, so
   * `pnpm install` executes in a worktree with nobody waiting on it and nobody to judge its exit
   * code. `setupJudgement` does not catch it either: it is asked by the OWNER, and there is no owner.
   *
   * Three shapes answer true and they are one question asked once: no owner record at all, an owner
   * that is no longer waiting for a setup, and an owner waiting for a DIFFERENT one. Marking the
   * install lost rather than launching it leaves the record and everything it printed readable,
   * which is what `lost` means everywhere else in this file.
   */
  private static isOrphanedSetup(
    record: SessionRecord,
    records: readonly SessionRecord[],
  ): boolean {
    if (record.setupFor === undefined) return false
    const owner = records.find((other) => other.sessionId === record.setupFor)
    return owner?.pendingSetup?.setupSessionId !== record.sessionId
  }

  /**
   * Whether this record is a Codex session still missing the id of its own conversation and young
   * enough to be worth asking for on every regular pass.
   *
   * `new` and `fork`, which is `CodexIdCapture.discoverable`'s answer and not a second copy of it:
   * both start a conversation Codex names itself, and the rollout it writes is where that name is.
   * The age bound is this pass's own - a record older than the window is left to the startup catch-up.
   */
  private static wantsCodexName(record: SessionRecord, now: number): boolean {
    return CodexIdCapture.discoverable(record)
      && now - record.createdAt <= Reconciler.codexNameWindowMillisecondsConst
  }

  /**
   * What the setup session says about the session waiting for it, in the order of who knows more:
   * the Host's runtime first, and only where the Host has none, the setup's own record.
   *
   * A dead runtime and an ended record are the same fact at two moments, the second being what
   * survives a Host that restarted once the install was over, and both are read the same way: exit 0
   * is success and nothing else is. A session started in a half-installed worktree is the failure
   * this whole path exists to prevent, so anything less certain than a clean exit ends it instead.
   */
  /**
   * One session that ran FOR another, judged by how it ended. Two of them exist - an install that
   * prepares a session, and a resolver that settles its merge - and they read the same ladder in the
   * same order for the same reasons, so it is written once. The pair of nouns is all that differs,
   * and the messages are what a person sees, so both are named rather than derived.
   */
  private static childJudgement(
    sessionId: string,
    childId: string,
    records: readonly SessionRecord[],
    live: ReadonlyMap<string, RuntimeSessionInfo>,
    words: {
      /** How the CHILD's own row is named: "its <session> session record is gone". */
      session: string
      /** How the thing that ran is named: "the <actor> exited with 1". */
      actor: string
      succeeded: ReconcileChange['kind']
      failed: (sessionId: string, reason: string) => ReconcileChange
    },
  ): ReconcileChange | null {
    const { session, actor, failed } = words
    const succeeded = { kind: words.succeeded, sessionId } as ReconcileChange
    const child = records.find((record) => record.sessionId === childId)
    if (!child) return failed(sessionId, `its ${session} session record is gone`)
    // Asked before the exit code, because a stopped child did not finish whatever code the platform
    // reports for a killed process - and on POSIX a signalled process reports 0, which would read
    // here as a clean run and start the session in a half-installed worktree.
    if (child.stopRequested) return failed(sessionId, `its ${actor} was stopped`)
    const runtime = live.get(childId)
    if (runtime) {
      if (runtime.alive) return null
      return runtime.exitCode === 0
        ? succeeded
        : failed(sessionId, `the ${actor} exited with ${runtime.exitCode ?? 'no exit code'}`)
    }
    if (child.life === 'starting') {
      // The Host has no runtime for it either, so the child's own replay is what this pass is about:
      // judging it now would end a session over a launch that is being repeated as we speak.
      if (child.pendingOperationId && child.pendingOperationKind) return null
      return failed(sessionId, `its ${session} session names no launch to replay`)
    }
    else if (child.life === 'ended')
      return child.exitCode === 0
        ? succeeded
        : failed(sessionId, `the ${actor} ended with ${child.exitCode ?? 'no exit code'}`)
    else if (child.life === 'live')
      return failed(sessionId, `its ${session} session is not on the Host any more`)
    else if (child.life === 'lost')
      return failed(sessionId, `its ${session} session was lost`)
    else
      throw new Error(`Unknown session life: ${JSON.stringify(child.life)}`)
  }

  private static setupJudgement(
    sessionId: string,
    setupSessionId: string,
    records: readonly SessionRecord[],
    live: ReadonlyMap<string, RuntimeSessionInfo>,
  ): ReconcileChange | null {
    return Reconciler.childJudgement(sessionId, setupSessionId, records, live, {
      session: 'setup',
      actor: 'setup',
      succeeded: 'setup-succeeded',
      failed: Reconciler.setupFailed,
    })
  }

  private static setupFailed(sessionId: string, reason: string): ReconcileChange {
    return { kind: 'setup-failed', sessionId, reason }
  }

  /**
   * The only field of a record whose value comes from another process, checked at the seam it enters
   * through.
   *
   * The Host outliving a client is the normal state here - closing a client detaches - so a Host from
   * a later build reporting a reason this one has never heard of is an upgrade, not a fault. Written
   * unchecked it would be a record the store refuses on write, which throws out of the reconcile loop
   * and leaves every change queued behind it unapplied, for ever. Dropped here it is simply absent,
   * and the ending is read from the mark this client wrote itself or from the exit code.
   */
  private static exitReasonOf(
    value: RuntimeSessionInfo['exitReason'],
  ): SessionExitReason | undefined {
    // The compile half of the mirror: a reason added to the Host's wire and not to
    // `SessionExitReason` fails this assignment, which is what keeps the two in step in the build.
    const declared: SessionExitReason | undefined = value
    // The runtime half, which the compiler cannot stand in for: the Host is a separate process and
    // may simply be a later build than this client.
    if (declared === 'process-exit' || declared === 'stopped'
      || declared === 'host-lost' || declared === 'spawn-failed')
      return declared
    return undefined
  }

  /**
   * The same reading as the setup's, for the same reason: a one-shot agent run is judged by how it
   * exited and by nothing else. Anything less certain than a clean exit leaves the merge where it
   * is, with the manual path open, rather than continuing over a resolution nobody confirmed.
   */
  private static resolveJudgement(
    sessionId: string,
    resolveSessionId: string,
    records: readonly SessionRecord[],
    live: ReadonlyMap<string, RuntimeSessionInfo>,
  ): ReconcileChange | null {
    return Reconciler.childJudgement(sessionId, resolveSessionId, records, live, {
      session: 'resolve',
      actor: 'resolver',
      succeeded: 'merge-resolve-succeeded',
      failed: Reconciler.resolveFailed,
    })
  }

  private static resolveFailed(sessionId: string, reason: string): ReconcileChange {
    return { kind: 'merge-resolve-failed', sessionId, reason }
  }
}
