import { BoundedMap } from '../../../shared/boundedMap'
import { CodexRolloutIndex, type CodexRolloutRef } from './codexRolloutIndex'

/** What a child thread's `session_meta` line states about where it came from. */
export interface CodexChildHeader {
  parentThreadId: string
  nickname: string | null
}

export interface CodexChildRolloutRef extends CodexRolloutRef {
  parentThreadId: string
  nickname: string | null
  /** 1 for a child of the session's own thread, 2 for a child of such a child. */
  depth: 1 | 2
}

/**
 * The child threads of one Codex conversation, found by their own rollout headers.
 *
 * Codex writes each sub-agent as a rollout of its own whose `session_meta` names `parent_thread_id`;
 * the parent's rollout says nothing a listing could use without reading it whole, so it is never
 * resolved here. Day directories from the session's start are listed by name, and each candidate's
 * header is read once for good: a thread's parent never changes, so the memo is never invalidated,
 * and a second listing reads no header it has already seen.
 */
export class CodexChildRollouts {
  private static readonly headerReadBytesConst = 16 * 1024
  private static readonly headersMaxConst = 4_096
  private static readonly headerReadConcurrencyConst = 16
  /** A rollout's name carries its start cut to the second, so it may read up to a second early. */
  private static readonly nameSlackMillisecondsConst = 1_000
  private static readonly sessionMetaPatternConst = /"type"\s*:\s*"session_meta"/
  private static readonly parentPatternConst = /"parent_thread_id"\s*:\s*"([^"\\]+)"/
  private static readonly nicknamePatternConst = /"agent_nickname"\s*:\s*"((?:[^"\\]|\\.)*)"/
  /** Past this key the line is the base instructions, whose text must never be taken for a field. */
  private static readonly instructionsKeyConst = '"base_instructions"'

  private readonly index: Pick<CodexRolloutIndex, 'candidatesBetween'>
  private readonly readPrefix: (file: string, byteLimit: number) => Promise<string>
  /** By file; null for a rollout that is no child thread. Oldest out past `headersMaxConst`. */
  private readonly headers = new Map<string, CodexChildHeader | null>()

  constructor(
    index: Pick<CodexRolloutIndex, 'candidatesBetween'>,
    readPrefix: (file: string, byteLimit: number) => Promise<string> = CodexRolloutIndex.readPrefix,
  ) {
    this.index = index
    this.readPrefix = readPrefix
  }

  /** Depth-1 children first, then each depth-2 child; a deeper thread is not listed. */
  async childrenOf(parentThreadId: string, since: number, until: number): Promise<CodexChildRolloutRef[]> {
    const candidates = await this.index.candidatesBetween(
      since - CodexChildRollouts.nameSlackMillisecondsConst,
      until,
    )
    const headers = await BoundedMap.run(
      candidates,
      CodexChildRollouts.headerReadConcurrencyConst,
      (candidate) => this.rememberedHeaderOf(candidate.file),
    )
    const byParent = new Map<string, { ref: CodexRolloutRef; header: CodexChildHeader }[]>()
    candidates.forEach((ref, position) => {
      const header = headers[position]
      if (header === null || ref.sessionId === parentThreadId) return
      byParent.set(header.parentThreadId, [...byParent.get(header.parentThreadId) ?? [], { ref, header }])
    })
    const depthOne = (byParent.get(parentThreadId) ?? [])
      .map(({ ref, header }) => ({ ...ref, ...header, depth: 1 as const }))
    const depthTwo = depthOne.flatMap((child) => (byParent.get(child.sessionId) ?? [])
      .map(({ ref, header }) => ({ ...ref, ...header, depth: 2 as const })))
    return [...depthOne, ...depthTwo]
  }

  /**
   * The header facts of the `session_meta` line, null for a rollout that is no child, undefined
   * while the line is not written far enough to tell. Only the part before the base instructions
   * is searched: a quoted field inside them must not make a thread a child.
   */
  static headerOf(prefix: string): CodexChildHeader | null | undefined {
    const newline = prefix.indexOf('\n')
    const line = newline < 0 ? prefix : prefix.slice(0, newline)
    const instructions = line.indexOf(CodexChildRollouts.instructionsKeyConst)
    const fields = instructions < 0 ? line : line.slice(0, instructions)
    const decided = newline >= 0 || instructions >= 0
    if (!CodexChildRollouts.sessionMetaPatternConst.test(fields)) return decided ? null : undefined
    const parent = CodexChildRollouts.parentPatternConst.exec(fields)?.[1]
    if (parent === undefined) return decided ? null : undefined
    const nickname = CodexChildRollouts.nicknamePatternConst.exec(fields)?.[1]
    let name: string | null = null
    if (nickname !== undefined)
      try { name = (JSON.parse(`"${nickname}"`) as string).trim() || null }
      catch { name = null }
    return { parentThreadId: parent, nickname: name }
  }

  /** A header that cannot be read or told yet is not remembered, so the next listing tries again. */
  private async rememberedHeaderOf(file: string): Promise<CodexChildHeader | null> {
    const known = this.headers.get(file)
    if (known !== undefined) return known
    let prefix: string
    try { prefix = await this.readPrefix(file, CodexChildRollouts.headerReadBytesConst) }
    catch { return null }
    const header = CodexChildRollouts.headerOf(prefix)
    if (header === undefined) return null
    this.headers.set(file, header)
    while (this.headers.size > CodexChildRollouts.headersMaxConst)
      this.headers.delete(this.headers.keys().next().value!)
    return header
  }
}
