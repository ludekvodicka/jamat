/**
 * Transcript lines in the shapes Claude Code writes.
 *
 * Written rather than captured: a real transcript long enough to test the widening pass is megabytes
 * of somebody's conversation, and every field this reader looks at is in the builders below. What
 * they carry that a tidied fixture would not are the records that must NOT be read as things that
 * were said - the tool call, the tool result that comes back as a user turn, the sidechain and meta
 * turns, and the wrapper Claude Code injects.
 */
export class ClaudeTranscriptTailFixtures {
  private static readonly timestampConst = '2026-08-17T10:00:00.000Z'

  /** What every builder below stamps, so a test states the expected `at` once. */
  static writtenAt(): number {
    return Date.parse(ClaudeTranscriptTailFixtures.timestampConst)
  }

  /** Content as a plain string, which is what a typed message usually is. */
  static userTurn(text: string, marks?: { isMeta?: true; isSidechain?: true }): string {
    return ClaudeTranscriptTailFixtures.row({
      type: 'user',
      ...marks,
      message: { role: 'user', content: text },
    })
  }

  /** Content as blocks, which is what a message with an image or a paste beside it is. */
  static userBlockTurn(text: string): string {
    return ClaudeTranscriptTailFixtures.row({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
  }

  /** A tool's answer, which Claude Code writes as a user turn of its own. */
  static toolResultTurn(): string {
    return ClaudeTranscriptTailFixtures.row({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    })
  }

  static assistantTurn(text: string): string {
    return ClaudeTranscriptTailFixtures.row({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-5-20260101', content: [{ type: 'text', text }] },
    })
  }

  /** A turn that only reached for a tool; it says nothing on its own. */
  static assistantToolTurn(): string {
    return ClaudeTranscriptTailFixtures.row({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5-20260101',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'x.ts' } }],
      },
    })
  }

  /**
   * Bulk no parser cares about, used to push the interesting records out of a narrow tail. Tool
   * results, because a single big one is exactly what buries a conversation below the first pass.
   */
  static padding(bytes: number): string {
    const line = ClaudeTranscriptTailFixtures.row({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_pad', content: 'x'.repeat(200) }],
      },
    })
    return line.repeat(Math.ceil(bytes / line.length))
  }

  private static row(record: object): string {
    return `${JSON.stringify({ timestamp: ClaudeTranscriptTailFixtures.timestampConst, ...record })}\n`
  }
}
