/**
 * Bodies the usage endpoint answers with, so the mapper is tested against what was actually sent
 * rather than against what a plan expected.
 *
 * `live()` is a verbatim capture of a 200 taken on 2026-08-17 from this machine's own login, kept
 * whole - the nine codenamed null buckets included - because the mapper's job is precisely to walk
 * past what it was not asked about. It is also the reason `limits[]` is read at all: on that account
 * `seven_day_opus` and `seven_day_sonnet` were null, and the model-scoped weekly existed only as a
 * `weekly_scoped` entry in the list.
 *
 * The other three are shapes no capture from here could produce: an account that DOES fill the flat
 * model-scoped pair in, one that answered a weekly and nothing else, and a body with no window at
 * all. They are written, not captured, and say so.
 */
export class ClaudeUsageFixtures {
  /** Captured verbatim from a live 200. Do not tidy: what is odd in it is the point. */
  static live(): unknown {
    return {
      five_hour: {
        utilization: 21.0,
        resets_at: '2026-08-17T11:39:59.916741+00:00',
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day: {
        utilization: 5.0,
        resets_at: '2026-08-23T14:59:59.916762+00:00',
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day_oauth_apps: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
      seven_day_cowork: null,
      seven_day_omelette: null,
      tangelo: null,
      iguana_necktie: null,
      omelette_promotional: null,
      nimbus_quill: {
        utilization: 0.0,
        resets_at: null,
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      cinder_cove: null,
      amber_ladder: null,
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        currency: null,
        decimal_places: null,
        disabled_reason: null,
        user_disabled: true,
        spend_limit_reached: false,
        credits_ever_enabled: true,
        daily: null,
        weekly: null,
      },
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 21,
          severity: 'normal',
          resets_at: '2026-08-17T11:39:59.916741+00:00',
          scope: null,
          is_active: true,
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 5,
          severity: 'normal',
          resets_at: '2026-08-23T14:59:59.916762+00:00',
          scope: null,
          is_active: false,
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 5,
          severity: 'normal',
          resets_at: '2026-08-23T14:59:59.916979+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: false,
        },
      ],
      spend: {
        used: { amount_minor: 0, currency: 'USD', exponent: 2 },
        limit: null,
        percent: 0,
        severity: 'normal',
        enabled: false,
        disabled_reason: null,
        cap: null,
        balance: null,
        auto_reload: null,
        disclaimer: 'Usage credits cover you when you hit your plan limits.',
        can_purchase_credits: false,
        can_toggle: false,
      },
      member_dashboard_available: false,
    }
  }

  /**
   * Written, not captured: an account whose flat model-scoped pair is filled in, with `limits[]`
   * restating one of the two. It is what says the same weekly cannot arrive twice.
   */
  static flatModelScoped(): unknown {
    return {
      five_hour: { utilization: 12, resets_at: '2026-08-17T11:39:59Z' },
      seven_day: { utilization: 40, resets_at: '2026-08-23T14:59:59Z' },
      seven_day_opus: { utilization: 63, resets_at: '2026-08-23T14:59:59Z' },
      seven_day_sonnet: { utilization: 7, resets_at: null },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 99,
          resets_at: '2026-08-30T00:00:00Z',
          scope: { model: { id: null, display_name: 'Opus' } },
        },
      ],
      extra_usage: { is_enabled: true, utilization: 18.4 },
    }
  }

  /** Written: an account that answered one window and named no other. */
  static weeklyOnly(): unknown {
    return {
      five_hour: null,
      seven_day: { utilization: 5, resets_at: '2026-08-23T14:59:59Z' },
      seven_day_opus: null,
      limits: [],
    }
  }

  /** Written: a body with nothing in it, which must map to no windows rather than to zeroes. */
  static empty(): unknown {
    return {}
  }
}
