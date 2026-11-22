/**
 * Transcript lines in the shape Claude Code 2.1 writes, taken from a real session file with
 * identifiers, request ids and timestamps replaced by example values.
 */
export class ClaudeLimitFixtures {
  static readonly resetsAtSecondsConst = 1_795_036_200

  static user(uuid = 'u-1', text = 'go on'): string {
    return ClaudeLimitFixtures.line({ type: 'user', uuid, isSidechain: false, timestamp: '2026-11-18T20:20:00.000Z',
      message: { role: 'user', content: text } })
  }

  static assistant(uuid = 'a-1', text = 'Done.'): string {
    return ClaudeLimitFixtures.line({ type: 'assistant', uuid, isSidechain: false, timestamp: '2026-11-18T20:21:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } })
  }

  static limit(uuid = 'limit-1', rateLimitType = 'five_hour', resetsAt: number = ClaudeLimitFixtures.resetsAtSecondsConst): string {
    const rateLimitInfo = { status: 'rejected', resetsAt, rateLimitType, overageStatus: 'rejected', isUsingOverage: false }
    return ClaudeLimitFixtures.line({
      parentUuid: 'a-1', isSidechain: false, type: 'assistant', uuid, timestamp: '2026-11-18T20:22:17.791Z',
      message: { id: '00000000-0000-4000-8000-000000000001', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence',
        type: 'message', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 10:10pm (Europe/Prague)" }] },
      requestId: 'req_example',
      apiError: 'usage_limit_reached',
      apiErrorParams: { rate_limit_info: rateLimitInfo },
      quotaLimits: { ...rateLimitInfo, unifiedRateLimitFallbackAvailable: false },
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
    })
  }

  static line(record: Record<string, unknown>): string {
    return `${JSON.stringify(record)}\n`
  }
}
