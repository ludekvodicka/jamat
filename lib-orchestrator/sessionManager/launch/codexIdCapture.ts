import type { CodexRolloutMatch } from '../../projectManager/codexRolloutView'
import type { SessionRecord } from '../records/sessionRecord.types'
import { LaunchPlanner } from './launchPlanner'

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
  /** A rollout head cut shorter than a prompt still names it only when this much of it agrees. */
  private static readonly promptHeadMinimumConst = 100

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
   * The one candidate that can only be this record's, or null. Five things narrow it: the window the
   * record launched in, the ids other records already hold, the parent its header names, no other
   * unnamed record in the same directory being able to claim it too, and there being exactly one
   * left.
   *
   * The rival check is what keeps two sessions started a minute apart in one directory from being
   * swapped. Codex writes its rollout only once it gets past its launch screens, so the second
   * session's rollout can be the only one on disk while the first is still parked in an update
   * menu; the first record then saw exactly one candidate and took it. A candidate another record
   * could equally own is left unclaimed, for every record, because staying unnamed is recoverable
   * and naming the wrong conversation is silent.
   *
   * The launch prompt is what lets such rivals be told apart: a record created with an
   * `initialPrompt` accepts only a rollout whose first user message is that prompt, so rivals with
   * different prompts stop blocking one another, whichever rollout lands first. Rivals with the same
   * prompt, or without one, keep the conservative answer.
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
      && CodexIdCapture.lineageFits(candidate, record)
      && CodexIdCapture.promptFits(candidate, record))
    if (eligible.length !== 1) return null
    const rivals = records.filter((other) =>
      other.sessionId !== record.sessionId
      && CodexIdCapture.discoverable(other)
      && other.endedReason === undefined
      && CodexIdCapture.sameDirectory(other, record))
    const contested = rivals.some((rival) => CodexIdCapture.accepts(eligible[0], rival))
    return contested ? null : eligible[0].sessionId
  }

  private static accepts(candidate: CodexRolloutMatch, record: SessionRecord): boolean {
    const { from, until } = CodexIdCapture.windowOf(record)
    return candidate.createdAt >= from
      && candidate.createdAt <= until
      && CodexIdCapture.lineageFits(candidate, record)
      && CodexIdCapture.promptFits(candidate, record)
  }

  /**
   * A record without a prompt accepts any first message, since what was typed into it is unknown. A
   * record with one needs the rollout to have written its first message and that message to be the
   * prompt, compared whitespace-collapsed; the rollout side is cut to a preview head, so a long
   * prompt matches when that head is its own beginning.
   */
  private static promptFits(candidate: CodexRolloutMatch, record: SessionRecord): boolean {
    const prompt = record.agent?.initialPrompt
    if (prompt === undefined || prompt.trim() === '') return true
    const message = candidate.firstUserMessage
    if (message === null) return false
    const wanted = prompt.replace(/\s+/g, ' ').trim()
    if (message === wanted) return true
    return message.length >= CodexIdCapture.promptHeadMinimumConst && wanted.startsWith(message)
  }

  /** Loose on purpose: a false match only leaves a record unnamed, never names it wrongly. */
  private static sameDirectory(a: SessionRecord, b: SessionRecord): boolean {
    const normalized = (record: SessionRecord): string =>
      LaunchPlanner.cwdOf(record).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return normalized(a) === normalized(b)
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
