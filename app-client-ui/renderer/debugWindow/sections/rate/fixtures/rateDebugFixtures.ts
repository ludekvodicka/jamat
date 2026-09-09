import type {
  RateMonitorDebugStatus,
  RateMonitorSnapshot,
  RateProviderDebug,
} from '../../../../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'

/** What a test can ask the stubbed bridge about afterwards, and the one push it can make. */
export interface RateBridgeStub {
  reads: number
  refreshes: number
  /** Publishes the change the monitor broadcasts when its content moves. */
  pushChanged: () => void
}

/**
 * A monitor holding a Claude that has gone stale on an expired token and a Codex that is answering.
 * Every test starts from this and overrides the one fact it is about.
 */
export class RateDebugFixtures {
  static readonly nowConst = 1_770_000_000_000

  static installBridge(
    status: RateMonitorDebugStatus = RateDebugFixtures.status(),
  ): RateBridgeStub {
    const stub: RateBridgeStub = { reads: 0, refreshes: 0, pushChanged: () => {} }
    const bridge = {
      rateMonitor: {
        debugStatus: () => {
          stub.reads += 1
          return Promise.resolve({ ok: true as const, value: status })
        },
        refresh: () => {
          stub.refreshes += 1
          return Promise.resolve({
            ok: true as const,
            value: { revision: 3, providers: { claude: { kind: 'never-read' as const },
              codex: { kind: 'never-read' as const } } } satisfies RateMonitorSnapshot,
          })
        },
        get: () => Promise.resolve({ ok: false as const, error: 'the section never asks for this' }),
      },
      onRateChanged: (callback: () => void) => {
        stub.pushChanged = callback
        return () => { stub.pushChanged = () => {} }
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'rateMonitor' | 'onRateChanged'>
    return stub
  }

  static removeBridge(): void {
    delete (window as unknown as { appClient?: unknown }).appClient
  }

  static status(overrides: Partial<RateMonitorDebugStatus> = {}): RateMonitorDebugStatus {
    return {
      capturedAt: RateDebugFixtures.nowConst,
      poll: {
        windowVisible: true,
        cadenceMilliseconds: 600_000,
        claudeFloorMilliseconds: 180_000,
      },
      providers: {
        claude: RateDebugFixtures.claude(),
        codex: RateDebugFixtures.codex(),
      },
      ...overrides,
    }
  }

  /**
   * Stale on an expired token: the last attempt and the last success have parted, which is the one
   * reading this screen exists for. Four windows, two of them model-scoped - the widget draws neither.
   */
  static claude(overrides: Partial<RateProviderDebug> = {}): RateProviderDebug {
    return {
      state: {
        kind: 'stale',
        fetchedAt: RateDebugFixtures.nowConst - 900_000,
        windows: [
          { durationMinutes: 300, usedPercent: 42, resetsAt: '2026-08-17T18:00:00.000Z' },
          { durationMinutes: 10_080, usedPercent: 12, resetsAt: '2026-08-22T06:00:00.000Z' },
          {
            durationMinutes: 10_080,
            usedPercent: 61,
            resetsAt: '2026-08-22T06:00:00.000Z',
            model: 'opus',
          },
          { durationMinutes: 10_080, usedPercent: 3, resetsAt: null, model: 'sonnet' },
        ],
        reason: 'OAuth token expired; the running Claude Code refreshes it',
      },
      lastAttemptAt: RateDebugFixtures.nowConst - 20_000,
      lastSuccessAt: RateDebugFixtures.nowConst - 900_000,
      lastReason: 'OAuth token expired; the running Claude Code refreshes it',
      oauthExpiresAt: RateDebugFixtures.nowConst - 180_000,
      extras: [{ label: 'Extra usage', detail: '$12.40 of $50.00 used' }],
      raw: RateDebugFixtures.claudeRaw(),
      ...overrides,
    }
  }

  static codex(overrides: Partial<RateProviderDebug> = {}): RateProviderDebug {
    return {
      state: {
        kind: 'ok',
        fetchedAt: RateDebugFixtures.nowConst - 60_000,
        windows: [
          { durationMinutes: 300, usedPercent: 7, resetsAt: '2026-08-17T17:30:00.000Z' },
          { durationMinutes: 10_080, usedPercent: 55, resetsAt: '2026-08-21T09:00:00.000Z' },
        ],
      },
      lastAttemptAt: RateDebugFixtures.nowConst - 60_000,
      lastSuccessAt: RateDebugFixtures.nowConst - 60_000,
      lastReason: null,
      oauthExpiresAt: null,
      extras: [],
      raw: { rate_limits: { primary: { used_percent: 7, window_minutes: 300 } } },
      ...overrides,
    }
  }

  /**
   * The usage endpoint's body as observed on a live account, kept as it came back. Half of it is
   * buckets the mapper knows nothing about and several are null on this plan; that is the point of
   * the raw block, so the record of what the endpoint answers stays faithful rather than tidy.
   */
  private static claudeRaw(): unknown {
    return {
      five_hour: {
        utilization: 21,
        resets_at: '2026-08-17T11:39:59.916741+00:00',
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day: {
        utilization: 5,
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
        utilization: 0,
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
}
