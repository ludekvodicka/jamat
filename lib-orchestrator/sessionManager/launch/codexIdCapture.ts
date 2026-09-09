import type { CodexRolloutMatch } from '../../projectManager/codexRolloutView'
import type { SessionRecord } from '../records/sessionRecord.types'

/**
 * Which conversation a Codex session was, worked out after the fact.
 *
 * Codex cannot be told an id before it starts, so a record created as `new` or as a `fork` never
 * names its own conversation and `AgentPresets.reopenProblem` refuses every reopen of one. The id
 * does exist: it is in the name of the rollout Codex wrote, filed under the directory the session
 * ran in. This decides whether a rollout can be claimed for a record, and it answers nothing far
 * more readily than it answers wrongly - landing on somebody else's conversation is the exact harm
 * the refusal was written to prevent, and it would be silent.
 *
 * A fork's rollout names the conversation it was cut from, in the same header, which is what lets a
 * fork be told from a fresh session started beside it in the same directory and the same minute.
 * The check runs both ways: a fresh session may claim only a rollout that names no parent.
 */
export class CodexIdCapture {
  /** Clock skew and the seconds a process takes to write its first line. */
  private static readonly createdSlackMillisecondsConst = 60_000
  /** The rollout is born with the process, so later candidates cannot belong to this launch. */
  private static readonly captureWindowMillisecondsConst = 300_000

  /**
   * The exact range a rollout of this record's may carry. The reader and matcher share it so a disk
   * walk never grows past what the matcher can accept.
   */
  static windowOf(record: SessionRecord): { from: number; until: number } {
    return {
      from: record.createdAt - CodexIdCapture.createdSlackMillisecondsConst,
      until: record.createdAt + CodexIdCapture.captureWindowMillisecondsConst,
    }
  }

  /**
   * Whether this is a Codex record whose conversation id can still be gone and found: a `new` or a
   * `fork` that has not named itself yet. `resume` was handed its id, and `continue` joined a
   * conversation by recency, which no id can name afterwards.
   *
   * Every pass that looks asks this one question, so the set of records that are looked for is one
   * set and not three drifting copies of it.
   */
  static discoverable(record: SessionRecord): boolean {
    const agent = record.agent
    if (!agent || agent.agentId !== 'codex' || agent.nativeSessionId !== undefined) return false
    if (agent.launchMode === 'new' || agent.launchMode === 'fork') return true
    else if (agent.launchMode === 'continue' || agent.launchMode === 'resume') return false
    else throw new Error(`Unknown launch mode: ${JSON.stringify(agent.launchMode)}`)
  }

  /**
   * The one candidate that can only be this record's, or null. Four things narrow it: the window the
   * record launched in, the ids other records already hold, the parent its header names, and there
   * being exactly one left.
   */
  static matchOf(
    candidates: readonly CodexRolloutMatch[],
    record: SessionRecord,
    records: readonly SessionRecord[],
  ): string | null {
    // The Host refused the launch, so Codex never ran and wrote nothing. Any candidate in the
    // window would be another session's.
    if (record.endedReason !== undefined) return null
    const taken = new Set(records
      .filter((other) => other.sessionId !== record.sessionId)
      .map((other) => other.agent?.nativeSessionId)
      .filter((id): id is string => id !== undefined))
    const { from, until } = CodexIdCapture.windowOf(record)
    const eligible = candidates.filter((candidate) =>
      candidate.createdAt >= from
      && candidate.createdAt <= until
      && !taken.has(candidate.sessionId)
      && CodexIdCapture.lineageFits(candidate, record))
    return eligible.length === 1 ? eligible[0].sessionId : null
  }

  /**
   * The header's parent link must agree with the record's launch: a fresh conversation names no
   * parent, a fork names exactly the one it was cut from, and a fork is never its parent's own
   * rollout however that rollout's header reads.
   *
   * Both directions carry weight. Without the first, a `new` record could claim the rollout of a
   * fork taken in the same directory a minute later, which is a real shape - forking is what people
   * do next in a directory they are already working in.
   */
  private static lineageFits(candidate: CodexRolloutMatch, record: SessionRecord): boolean {
    const agent = record.agent
    if (!agent) return false
    if (agent.launchMode === 'new')
      return candidate.forkedFromId === null
    else if (agent.launchMode === 'fork')
      return agent.forkParentId !== undefined
        && candidate.forkedFromId === agent.forkParentId
        && candidate.sessionId !== agent.forkParentId
    else if (agent.launchMode === 'continue' || agent.launchMode === 'resume')
      return false
    else
      throw new Error(`Unknown launch mode: ${JSON.stringify(agent.launchMode)}`)
  }
}
