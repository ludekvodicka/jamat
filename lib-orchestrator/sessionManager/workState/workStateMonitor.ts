import type {
  RuntimeInspectResult,
  RuntimeListResult,
  RuntimeRef,
  RuntimeSessionInfo,
} from '../../../app-host/app/wire/hostWire.js'
import type { HostCallResult } from '../../hostClient/hostClient.types'
import type { SessionRecordAgent } from '../records/sessionRecord.types'
import type { SessionActivity, SessionActivityDetail } from '../sessionManagerApi.types'
import type { AgentWorkFrame, AgentWorkHint, AgentWorkInspection } from './agentWorkInspector.types'
import { AgentWorkInspectorClaude } from './agentWorkInspectorClaude'
import { AgentWorkInspectorCodex } from './agentWorkInspectorCodex'
import { ScreenTail } from './screenTail'

/**
 * All the monitor needs of the Host client: it reads through the one connection the client already
 * holds and never opens another. `runtime.list` is not on it - the listing is handed in.
 */
export interface HostRuntimeReader {
  runtimeInspect(target: RuntimeRef): Promise<HostCallResult<RuntimeInspectResult>>
}

export interface WorkStateMonitorDeps {
  client: HostRuntimeReader
  /** Null for a shell and for a runtime with no record: nothing classifies a plain terminal. */
  agentOf: (runtimeSessionId: string) => SessionRecordAgent['agentId'] | null
  onChanged: () => void
}

interface SessionWorkState {
  activity: SessionActivity
  activityDetail: SessionActivityDetail | null
  outputSeq: number
  /** When the output that last looked like work arrived. Its age is the whole settle rule. */
  workingEvidenceAt: number | null
  /**
   * What the last inspection actually saw. The activity is the answer; this is the reason for it,
   * and it is kept because a classifier that throws its evidence away can be wrong in silence - the
   * missed plan prompt of 2026-08-19 needed a scratchpad probe to see at all.
   */
  inspection: AgentWorkInspection
}

/**
 * What each agent session is doing, read from the listings the session manager already fetches.
 *
 * **It holds no timer and asks for no listing of its own.** There is one poll of one Host in this
 * client, on the manager's cadence - 2 s while somebody is looking, 15 s while nobody is - and this
 * is handed each answer as it arrives. That is also why nothing happens while the Host is
 * unreachable: a listing that never came is not classified, and the last known activities stand.
 *
 * Two economies decide the rest. **The listing already carries `outputSeq`**, so noticing that a
 * session has produced nothing since the last look costs nothing at all; only a session whose output
 * moved is worth the `runtime.inspect` that renders its screen.
 *
 * The settle rule is the second. V1 ran a ladder of timers per session - fast idle, silence, tool
 * expiry, done - to decide when evidence had gone stale. Here the Host timestamps the output itself,
 * so the whole ladder is one sentence: **work is what the last 15 seconds of output looked like.** A
 * screen still showing a spinner over output that stopped a minute ago is a finished turn, and it
 * says so on the first look rather than after a timer of ours happens to fire. Waiting is not on
 * that clock at all - a permission prompt or a question menu is evidence in itself and holds until
 * the screen changes.
 *
 * **Background work has a companion sentence** *(2026-08-20)*: work is what the last 15 seconds of
 * output looked like, and background is what the current screen says right now. A Claude shell or
 * sub-agent, or a Codex background terminal, can print nothing for minutes after the foreground
 * turn ends. Ageing that by output would drop the row to idle with the work plainly listed on
 * screen. The sighting arms the clock instead, and the settle-due re-inspection re-sights it: one
 * `runtime.inspect` per 15 s per silent background session, and the row holds green until the status
 * goes.
 */
export class WorkStateMonitor {
  private static readonly silenceMillisecondsConst = 15_000
  private static readonly noEvidenceConst: AgentWorkInspection = {
    hint: 'unknown',
    evidence: [],
  }

  private readonly states = new Map<string, SessionWorkState>()
  private observing = false
  private stopped = false

  constructor(private readonly deps: WorkStateMonitorDeps) {}

  /**
   * One listing, classified. A listing that arrives while the previous pass is still rendering
   * screens is dropped rather than queued: the next poll is two seconds away and carries fresher
   * output sequences than anything queued behind an inspect would.
   */
  async observe(listing: RuntimeListResult): Promise<void> {
    if (this.stopped || this.observing) return
    this.observing = true
    try {
      await this.classifyListing(listing)
    } finally {
      this.observing = false
    }
  }

  /**
   * Detach: what was learned is dropped and nothing is learned again. No runtime is touched.
   *
   * The flag is the whole of it. A pass is a chain of awaited `runtime.inspect` calls, so one is
   * usually still in flight when this is called: without the flag it would go on inspecting through
   * a client that is closing, refill the map that was just cleared, and report a change to a manager
   * that has already let go of this monitor.
   */
  stop(): void {
    this.stopped = true
    this.states.clear()
  }

  /** Null for a session this has never classified; the caller decides what that means. */
  activity(runtimeSessionId: string): SessionActivity | null {
    return this.states.get(runtimeSessionId)?.activity ?? null
  }

  /** The optional surface distinction inside `working`; null remains compatible with older peers. */
  activityDetail(runtimeSessionId: string): SessionActivityDetail | null {
    return this.states.get(runtimeSessionId)?.activityDetail ?? null
  }

  /**
   * Why that activity: the hint and the evidence of the last screen actually rendered. Null for a
   * session never classified. Read by the Debug window through the session manager, and by nothing
   * that decides anything - a surface draws this, it does not reason from it.
   */
  inspection(runtimeSessionId: string): AgentWorkInspection | null {
    return this.states.get(runtimeSessionId)?.inspection ?? null
  }

  private async classifyListing(listing: RuntimeListResult): Promise<void> {
    const now = Date.now()
    const seen = new Set<string>()
    let changed = false
    for (const session of listing.sessions) {
      const agentId = this.deps.agentOf(session.runtimeSessionId)
      if (agentId === null || !session.alive) continue
      seen.add(session.runtimeSessionId)
      if (!this.needsInspection(session, now)) continue
      const inspection = await this.classify(listing.hostInstanceId, session, agentId)
      // Checked after every await: `stop` can land in any of these gaps, and what it means is that
      // nothing more is written and nobody is told.
      if (this.stopped) return
      changed = this.apply(session, inspection, agentId, now) || changed
    }
    changed = this.forget(seen) || changed
    if (changed) this.deps.onChanged()
  }

  /**
   * The whole poll discipline. A session that has produced nothing since the last look shows the
   * same screen, so rendering it again would answer a question already answered - unless its work
   * has just gone quiet for long enough to settle, which is the one verdict that changes without any
   * new output.
   */
  private needsInspection(session: RuntimeSessionInfo, now: number): boolean {
    const state = this.states.get(session.runtimeSessionId)
    if (state === undefined) return true
    if (state.outputSeq !== session.outputSeq) return true
    return WorkStateMonitor.settleDue(state, now)
  }

  private static settleDue(state: SessionWorkState, now: number): boolean {
    return state.activity === 'working'
      && state.workingEvidenceAt !== null
      && now - state.workingEvidenceAt >= WorkStateMonitor.silenceMillisecondsConst
  }

  private async classify(
    hostInstanceId: string,
    session: RuntimeSessionInfo,
    agentId: SessionRecordAgent['agentId'],
  ): Promise<AgentWorkInspection> {
    const inspected = await this.deps.client.runtimeInspect({
      hostInstanceId,
      runtimeSessionId: session.runtimeSessionId,
      generation: session.generation,
    })
    // A refused call or a runtime with no projection yet is an absence of evidence, and that is
    // exactly what `unknown` says. The settle rule below still decides on the age of the output.
    if (!inspected.ok || inspected.value.projection === null) return WorkStateMonitor.noEvidenceConst
    return WorkStateMonitor.inspectorFor(agentId)(ScreenTail.frameOf(inspected.value.projection))
  }

  private apply(
    session: RuntimeSessionInfo,
    inspection: AgentWorkInspection,
    agentId: SessionRecordAgent['agentId'],
    now: number,
  ): boolean {
    const state: SessionWorkState = this.states.get(session.runtimeSessionId)
      ?? {
        activity: 'unknown',
        activityDetail: null,
        outputSeq: session.outputSeq,
        workingEvidenceAt: null,
        inspection: WorkStateMonitor.noEvidenceConst,
      }
    const previousActivity = state.activity
    const previousDetail = state.activityDetail
    state.inspection = inspection
    const mapped = WorkStateMonitor.activityOf(inspection.hint)
    // Claude can leave a dead busy row on screen, so its foreground evidence ages by output. Codex
    // replaces `Working` with its finished layout, so a currently sighted row is authoritative.
    if (inspection.hint === 'background') state.workingEvidenceAt = now
    else if (mapped === 'working') {
      if (agentId === 'claude') state.workingEvidenceAt = session.lastOutputAt ?? now
      else if (agentId === 'codex') state.workingEvidenceAt = now
      else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
    }
    else if (mapped === 'waiting') state.workingEvidenceAt = null
    state.activity = WorkStateMonitor.settle(
      mapped,
      state.workingEvidenceAt !== null
        && now - state.workingEvidenceAt < WorkStateMonitor.silenceMillisecondsConst,
      state.workingEvidenceAt !== null,
    )
    if (inspection.hint === 'background') state.activityDetail = 'background'
    else if (mapped === 'working' || state.activity !== 'working') state.activityDetail = null
    state.outputSeq = session.outputSeq
    this.states.set(session.runtimeSessionId, state)
    return state.activity !== previousActivity || state.activityDetail !== previousDetail
  }

  /**
   * `fresh` is the age of the output the evidence was read from, not of the reading: a busy screen
   * over silent output has already finished. `seenWorking` is what separates a Codex session that
   * has worked and gone quiet - idle - from one nothing has ever recognised, which stays unknown
   * because Codex publishes no layout that means finished.
   */
  private static settle(mapped: SessionActivity, fresh: boolean, seenWorking: boolean): SessionActivity {
    if (mapped === 'working') return fresh ? 'working' : 'idle'
    else if (mapped === 'waiting') return 'waiting'
    else if (mapped === 'idle') return fresh ? 'working' : 'idle'
    else if (mapped === 'unknown') {
      if (fresh) return 'working'
      return seenWorking ? 'idle' : 'unknown'
    }
    else
      throw new Error(`Unknown session activity: ${JSON.stringify(mapped)}`)
  }

  /**
   * A tool line and a spinner are both work; a permission prompt and a menu are both a person. So
   * is a background status: the turn may be over, but work it started is not, and the person asked
   * for that to read as work rather than as finished.
   */
  private static activityOf(hint: AgentWorkHint): SessionActivity {
    if (hint === 'working') return 'working'
    else if (hint === 'tool-use') return 'working'
    else if (hint === 'background') return 'working'
    else if (hint === 'blocked') return 'waiting'
    else if (hint === 'waiting') return 'waiting'
    else if (hint === 'idle') return 'idle'
    else if (hint === 'unknown') return 'unknown'
    else
      throw new Error(`Unknown work hint: ${JSON.stringify(hint)}`)
  }

  private static inspectorFor(
    agentId: SessionRecordAgent['agentId'],
  ): (frame: AgentWorkFrame) => AgentWorkInspection {
    if (agentId === 'claude') return (frame) => AgentWorkInspectorClaude.inspect(frame)
    else if (agentId === 'codex') return (frame) => AgentWorkInspectorCodex.inspect(frame)
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /** A runtime that died or was removed leaves nothing behind: its activity is not news any more. */
  private forget(seen: ReadonlySet<string>): boolean {
    let changed = false
    for (const runtimeSessionId of [...this.states.keys()]) {
      if (seen.has(runtimeSessionId)) continue
      this.states.delete(runtimeSessionId)
      changed = true
    }
    return changed
  }
}
