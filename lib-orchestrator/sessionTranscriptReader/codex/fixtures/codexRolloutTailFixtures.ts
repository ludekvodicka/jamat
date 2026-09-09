/**
 * Rollout lines in the shapes Codex actually writes.
 *
 * `rollout-sample.jsonl` beside this file is a real capture carried over from V1 - the same capture
 * the model reader's fixtures use, copied so no file of this subsystem is reached for from another -
 * and it is what says the parser reads a rollout rather than a plan's idea of one: one typed message
 * and two answers, each of them written once as a `response_item` and repeated as an `event_msg`.
 * The builders below are written, and exist for the shapes a single capture cannot hold - the
 * injected context block, a message long enough to be cut, a tail deep enough to widen.
 */
export class CodexRolloutTailFixtures {
  private static readonly timestampConst = '2026-08-17T10:00:00.000Z'

  static sampleFileName(): string {
    return 'rollout-sample.jsonl'
  }

  /** Everything the capture said, in the order it said it. */
  static sampleTail(): { role: string; text: string; at: number }[] {
    return [
      {
        role: 'user',
        text: 'Create a file named hello.txt whose contents are exactly the single line: hi',
        at: Date.parse('2026-07-10T11:00:57.100Z'),
      },
      {
        role: 'assistant',
        text: "I'll create the file with exactly that one line.",
        at: Date.parse('2026-07-10T11:00:58.300Z'),
      },
      { role: 'assistant', text: 'Created hello.txt.', at: Date.parse('2026-07-10T11:01:00.300Z') },
    ]
  }

  static writtenAt(): number {
    return Date.parse(CodexRolloutTailFixtures.timestampConst)
  }

  static row(type: string, payload: object): string {
    return `${JSON.stringify({ timestamp: CodexRolloutTailFixtures.timestampConst, type, payload })}\n`
  }

  static userMessage(text: string): string {
    return CodexRolloutTailFixtures.row('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
  }

  static assistantMessage(text: string): string {
    return CodexRolloutTailFixtures.row('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    })
  }

  /** What Codex repeats for its own display; the same words as the `response_item` beside it. */
  static agentMessageEvent(text: string): string {
    return CodexRolloutTailFixtures.row('event_msg', { type: 'agent_message', message: text })
  }

  /** Bulk no parser cares about, used to push the interesting records out of a narrow tail. */
  static padding(bytes: number): string {
    const line = CodexRolloutTailFixtures.row('response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'exec-pad',
      input: 'x'.repeat(200),
    })
    return line.repeat(Math.ceil(bytes / line.length))
  }
}
