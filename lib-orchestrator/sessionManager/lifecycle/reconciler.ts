import { WorktreeLifecycle } from '../../worktrees/worktreeLifecycle'
import type { RuntimeListResult, RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import type { SessionExitReason, SessionRecord } from '../records/sessionRecord.types'
import { ScriptRunOutcome } from '../scripts/scriptRunOutcome'
import { ScriptRunPlanning, type ScriptRunChange } from '../scripts/scriptRunPlanning'
import { SessionScriptDefinitions, type SessionScriptGate } from '../scripts/sessionScriptDefinitions'
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
    binding: { hostInstanceId: string; generation: number }
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
   * A script run that a gate of its parent waits for finished cleanly. `sessionId` is the PARENT's,
   * never the run's: the run is the evidence, not the subject. `before`: the launch that was waiting
   * can run. `finish`: the next check starts, or the Finish continues. `merge`: the merge carries on
   * from whatever the resolver left in the worktree.
   */
  | { kind: 'script-succeeded'; sessionId: string; gate: SessionScriptGate }
  /**
   * The run failed, or there is no longer anything to say it succeeded. `before`: the parent ends
   * with this reason; its worktree, its branch and its link to the run all stay. `finish`: the Finish
   * stops and the chain keeps the reason. `merge`: the phase stays, so the manual path is still open.
   * `action`: the SVN action writes the verdict and its next client step reads the disk.
   */
  | { kind: 'script-failed'; sessionId: string; gate: SessionScriptGate; reason: string }
  /**
   * An SVN action has a client step to take that no drive of this process holds: a client stage, a
   * verdict to judge, a relaunch whose wait is over, or a resolver past its time limit to stop. After
   * a client restart this is how it goes on.
   */
  | { kind: 'svn-action-due'; sessionId: string }
  /** Read the running agent's confirmation of its launch generation, never provider history. */
  | { kind: 'name-conversation'; sessionId: string }
  /** The process of an SVN worktree session is gone and its cleanup is due: judge and remove it off this loop. */
  | { kind: 'clean-worktree'; sessionId: string }
  /** A run that is over: its log and history entry are written, or its record goes. See `ScriptRunPlanning`. */
  | ScriptRunChange

/**
 * The one place that decides what a session's record should say. It is pure - records and the Host's
 * answer in, changes out - so every state this library has to survive can be tested as plain data.
 */
export class Reconciler {
  static plan(
    records: readonly SessionRecord[],
    listing: RuntimeListResult | null,
    now: number = Date.now(),
    /** When this client process began; the first cleanup judgement after it is always due. */
    clientStartedAt = 0,
    /** The SVN actions a drive of this process holds now. */
    held: ReadonlySet<string> = new Set(),
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
    for (const record of records)
      for (const { gate, runId, words } of SessionScriptDefinitions.gatesOf(record)) {
        // A parent whose OWN runtime the Host has is left to the general rules: see the live loop.
        if (!SessionScriptDefinitions.judging(gate, record) || (gate === 'before' && live.has(record.sessionId))) continue
        const judged = ScriptRunOutcome.judge(runId, records, live, words)
        if (judged.kind === 'running') continue
        else if (judged.kind === 'succeeded')
          changes.push({ kind: 'script-succeeded', sessionId: record.sessionId, gate })
        else if (judged.kind === 'failed')
          changes.push({ kind: 'script-failed', sessionId: record.sessionId, gate, reason: judged.reason })
        else
          throw new Error(`Unknown run judgement: ${JSON.stringify(judged satisfies never)}`)
      }
    changes.push(...WorktreeLifecycle.due(records, now, clientStartedAt, held))
    for (const record of records) {
      if (record.life !== 'live' && record.life !== 'starting') continue
      const found = live.get(record.sessionId)
      /*
       * The before gate, judged above, stands in front of every general rule below. A `starting`
       * record whose own launch is waiting for a setup session is judged by that setup and by
       * nothing else: replaying it would start the session in a worktree whose dependencies are
       * still being installed, which is the whole reason the setup exists, and losing it would throw
       * away a session that has an install running behind it.
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
      if ((record.pendingSetup?.local === true || SessionScriptDefinitions.judging('before', record)) && !found) continue
      if (!found) {
        // The Host answered and does not have it. A launch that crashed between the record write and
        // the Host's answer replays the SAME operationId, which the Host itself dedupes. Both halves
        // of the pending pair are required: an id with no kind cannot say which launch to repeat, so
        // the record is lost rather than replayed as a guess.
        if (record.life === 'starting' && record.pendingOperationId && record.pendingOperationKind
          && !Reconciler.isOrphanedRun(record, records)) {
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
          binding: { hostInstanceId: listing.hostInstanceId, generation: found.generation },
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
        if (Reconciler.wantsConversationName(record))
          changes.push({ kind: 'name-conversation', sessionId: record.sessionId })
      }
    }
    // After the live loop, so a run is settled from the record a previous pass marked ended: the
    // exit code is on it by then, and the Host still holds the dead runtime the log is read from.
    changes.push(...ScriptRunPlanning.changes(records, new Set(live.keys())))
    const known = new Set(records.map((record) => record.sessionId))
    for (const session of listing.sessions)
      if (session.alive && !known.has(session.runtimeSessionId))
        changes.push({ kind: 'orphan', runtimeSessionId: session.runtimeSessionId })
    return changes
  }

  /**
   * A script run is worth launching only while its parent still names THIS one through its gate.
   *
   * `mintSetup` writes the install record first and arms the waiting record second,
   * which is the right order - it is what stops a waiting record ever pointing at a setup that is
   * already condemned - but it leaves a state on disk between the two writes: an install `starting`
   * under its own pending pair, and an owner that still names the OLD install or none at all. The
   * general rule above reads that install as a launch that never reached the Host and runs it, so
   * `pnpm install` executes in a worktree with nobody waiting on it and nobody to judge its exit
   * code. The gate loop does not catch it either: it is asked by the PARENT, and there is no parent.
   * A starting resolver whose parent cleared its pointer is the same shape: an agent committing
   * into a worktree that no merge waits on.
   *
   * Three shapes answer true and they are one question asked once: no parent record at all, a parent
   * that names no run through the gate, and a parent naming a DIFFERENT one. Marking the run lost
   * rather than launching it leaves the record and everything it printed readable, which is what
   * `lost` means everywhere else in this file.
   *
   * A run that is not replayable is never launched from here at all: the session that asked for it
   * did so once, and a run started for it after a client restart would be a run nobody reads.
   */
  private static isOrphanedRun(
    record: SessionRecord,
    records: readonly SessionRecord[],
  ): boolean {
    const link = record.scriptOf
    if (link === undefined) return false
    const definition = SessionScriptDefinitions.of(link)
    if (!definition.replayable) return true
    const parent = records.find((other) => other.sessionId === link.sessionId)
    return parent === undefined || definition.pointerOf(parent) !== record.sessionId
  }

  /**
   * A pending cleanup of an SVN worktree, once nothing can still run in it: the process is gone and
   * its handles had time to go, no run of it can still stand in the worktree, no SVN action (running
   * or waiting for the person) or Finish check owns the record, and no launch is on its way.
   */


  /** A running terminal may select a different conversation without launching a new process. */
  private static wantsConversationName(record: SessionRecord): boolean {
    return record.agent !== undefined && record.agent.identityLaunchId !== undefined
      && (record.endedReason === undefined || record.life === 'live' || record.agent.launchAccountId !== undefined
        && record.agent.launchAccountId !== (record.agent.accountId ?? 'main'))
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
}
