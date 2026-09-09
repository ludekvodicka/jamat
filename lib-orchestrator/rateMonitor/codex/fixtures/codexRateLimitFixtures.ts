/** `account/rateLimits/read` results, in the shapes the server actually answers with. */
export class CodexRateLimitFixtures {
  /**
   * Captured verbatim from codex-cli 0.146.0 on 2026-08-17. Both spellings of the same snapshot are
   * present, `secondary` is null on a weekly plan, and `codex_bengalfox` is a per-model entry that
   * lives beside the account's own limit and must not be mistaken for it.
   */
  static liveResult(): unknown {
    return {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 73, windowDurationMins: 10_080, resetsAt: 1_787_251_016 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        individualLimit: null,
        spendControlReached: false,
        planType: 'prolite',
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: 'codex_bengalfox',
          limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_787_559_307 },
          secondary: null,
        },
        codex: {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 73, windowDurationMins: 10_080, resetsAt: 1_787_251_016 },
          secondary: null,
        },
      },
      rateLimitResetCredits: { availableCount: 0, credits: [] },
    }
  }

  /** An older server: the flat snapshot only, with both windows filled in. */
  static flatOnlyResult(): unknown {
    return {
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_787_251_016 },
        secondary: { usedPercent: 12.5, windowDurationMins: 10_080, resetsAt: null },
      },
    }
  }

  /** The two spellings disagreeing, which is what proves which one is read. */
  static disagreeingResult(): unknown {
    return {
      rateLimits: {
        primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: null },
      },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: null } },
      },
    }
  }

  /** Windows that cannot be drawn: no length, a length of zero, and a percentage that is not one. */
  static unusableResult(): unknown {
    return {
      rateLimits: {
        primary: { usedPercent: 50, windowDurationMins: 0, resetsAt: null },
        secondary: { usedPercent: 'plenty', windowDurationMins: 10_080, resetsAt: null },
      },
    }
  }
}
