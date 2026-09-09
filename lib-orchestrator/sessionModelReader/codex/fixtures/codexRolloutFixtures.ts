/**
 * Rollout lines in the shapes Codex actually writes.
 *
 * `rollout-sample.jsonl` beside this file is a real capture carried over from V1 and is what says the
 * parser reads a rollout rather than a plan's idea of one: it holds two `token_count` records around
 * one `turn_context`, so the last one is the answer. The builders below are written, and exist for
 * the shapes a single capture cannot hold - the two older effort keys, a turn with no count of its
 * own yet, a count with no settings in front of it.
 */
export class CodexRolloutFixtures {
  static sampleFileName(): string {
    return 'rollout-sample.jsonl'
  }

  /** What the sample's own last pair says, so a test states the expectation once. */
  static sampleAnswer(): { model: string; modelLabel: string; effortLevel: string; contextTokens: number; contextWindow: number } {
    return {
      model: 'gpt-5.6-sol',
      modelLabel: 'GPT-5.6 Sol',
      effortLevel: 'max',
      contextTokens: 103_147,
      contextWindow: 258_400,
    }
  }

  static row(type: string, payload: object): string {
    return `${JSON.stringify({ timestamp: '2026-08-17T10:00:00.000Z', type, payload })}\n`
  }

  /** `effort` is the current key; `reasoning_effort` and the nested one are what old rollouts hold. */
  static turnContext(model: string, effort: object): string {
    return CodexRolloutFixtures.row('turn_context', { model, ...effort })
  }

  static tokenCount(totalTokens: number, contextWindow = 258_400): string {
    return CodexRolloutFixtures.row('event_msg', {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: totalTokens },
        model_context_window: contextWindow,
      },
    })
  }

  /** Bulk no parser cares about, used to push the interesting records out of a narrow tail. */
  static padding(bytes: number): string {
    const line = CodexRolloutFixtures.row('response_item', { type: 'message', role: 'assistant', text: 'x'.repeat(200) })
    return line.repeat(Math.ceil(bytes / line.length))
  }
}
