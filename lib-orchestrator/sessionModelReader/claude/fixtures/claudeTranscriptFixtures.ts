/**
 * Transcript lines in the shapes Claude Code writes.
 *
 * Written rather than captured: a real transcript of a session long enough to test the widening pass
 * is megabytes of somebody's conversation, and every field this reader looks at is in the four
 * builders below. What they carry that a tidied fixture would not is the synthetic turn and the
 * compact boundary - the two records whose whole point is that they must not be read like the others.
 */
export class ClaudeTranscriptFixtures {
  /** A real API turn. The three usage fields are the ones that add up to the context size. */
  static assistantTurn(model: string, usage: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }): string {
    return `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-17T10:00:00.000Z',
      message: { role: 'assistant', model, usage: { output_tokens: 120, ...usage } },
    })}\n`
  }

  /**
   * What Claude Code writes for a local-only interaction: an assistant turn carrying no real model
   * and no real usage. A reader that took it would name the model `<synthetic>`.
   */
  static syntheticTurn(): string {
    return ClaudeTranscriptFixtures.assistantTurn('<synthetic>', {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  }

  /** The record a compact leaves behind; `postTokens` is the true size of what survived it. */
  static compactBoundary(postTokens: number): string {
    return `${JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-08-17T10:00:00.000Z',
      compactMetadata: { trigger: 'manual', preTokens: 940_000, postTokens },
    })}\n`
  }

  /** Bulk no parser cares about, used to push the interesting records out of a narrow tail. */
  static padding(bytes: number): string {
    const line = `${JSON.stringify({
      type: 'user',
      timestamp: '2026-08-17T10:00:00.000Z',
      message: { role: 'user', content: 'x'.repeat(200) },
    })}\n`
    return line.repeat(Math.ceil(bytes / line.length))
  }
}
