import type {
  HostDebugRuntimeRow,
  HostDebugStatus,
  HostPingResult,
} from '../../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'

/** What a test can ask the stubbed bridge about afterwards, and the one push it can make. */
export interface HostBridgeStub {
  pings: number
  startHosts: number
  sections: (string | null)[]
  /** Publishes a ping the main process took on its own, the way its loop does. */
  pushPing: (result: HostPingResult) => void
}

/**
 * A Host that is running and reachable, with one live runtime, one dead one and one orphan. Every
 * test starts from this and overrides the one fact it is about.
 */
export class HostDebugFixtures {
  static readonly nowConst = 1_770_000_000_000

  /**
   * The bridge every host node reads through, stubbed. One installer rather than one per test file:
   * four nodes ask the same four questions, and four copies of the answers would drift.
   */
  static installBridge(status: HostDebugStatus = HostDebugFixtures.status()): HostBridgeStub {
    const stub: HostBridgeStub = { pings: 0, startHosts: 0, sections: [], pushPing: () => {} }
    const bridge = {
      debug: {
        hostStatus: () => Promise.resolve({ ok: true as const, value: status }),
        pingHost: () => {
          stub.pings += 1
          return Promise.resolve({
            ok: true as const,
            value: { at: 1, ok: false, detail: 'nothing there' } satisfies HostPingResult,
          })
        },
        sectionActive: (section: string | null) => {
          stub.sections.push(section)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
      },
      sessions: {
        startHost: () => {
          stub.startHosts += 1
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: undefined },
          })
        },
      },
      onSessionsChanged: () => () => undefined,
      onHostPingResult: (callback: (result: HostPingResult) => void) => {
        stub.pushPing = callback
        return () => { stub.pushPing = () => {} }
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'debug' | 'sessions' | 'onSessionsChanged' | 'onHostPingResult'>
    return stub
  }

  static removeBridge(): void {
    delete (window as unknown as { appClient?: unknown }).appClient
  }

  static status(overrides: Partial<HostDebugStatus> = {}): HostDebugStatus {
    return {
      capturedAt: HostDebugFixtures.nowConst,
      presence: 'running',
      descriptor: HostDebugFixtures.descriptor(),
      clientProtocol: { major: 1, minor: 0 },
      expectedHostVersion: '2026.08.10.1',
      controller: { launching: false, autoStartAttempted: true, lastStartError: null },
      watcher: {
        descriptorFile: 'C:/state/jamat-v3/host/descriptor.json',
        pollMilliseconds: 500,
        identity: 'host-1:51234',
      },
      eventsSocket: {
        connected: true,
        cursor: 12,
        resyncOwed: false,
        reconnectAttempt: 0,
        lastSubscribed: {
          at: HostDebugFixtures.nowConst - 60_000,
          throughRevision: 12,
          replayed: 2,
          truncated: false,
        },
      },
      lease: {
        controllerId: 'jamat-client-1',
        leaseId: 'lease-1',
        expiresAt: HostDebugFixtures.nowConst + 15_000,
      },
      reconcile: {
        lastAt: HostDebugFixtures.nowConst - 2_000,
        lastReason: 'poll',
        lastListingOk: true,
        refreshPending: false,
      },
      poll: {
        windowVisible: true,
        cadenceMilliseconds: 2_000,
        lastTickAt: HostDebugFixtures.nowConst - 2_000,
      },
      launch: {
        ok: true,
        command: 'C:/tools/electron.exe',
        args: ['--import', 'tsx', 'Q:/tree/app-host/start.ts'],
        cwd: 'Q:/tree',
        refusal: null,
      },
      runtimes: [
        HostDebugFixtures.row({ runtimeSessionId: 'live-1', sessionTitle: 'A recorded session' }),
        HostDebugFixtures.row({
          runtimeSessionId: 'dead-1',
          sessionTitle: 'An ended session',
          alive: false,
          exitedAt: HostDebugFixtures.nowConst - 30_000,
          exitCode: 3,
          exitReason: 'process-exit',
        }),
        HostDebugFixtures.row({ runtimeSessionId: 'stray-1', orphan: true }),
      ],
      counts: { live: 2, dead: 1, orphans: 1 },
      ...overrides,
    }
  }

  static descriptor(): NonNullable<HostDebugStatus['descriptor']> {
    return {
      pid: 4_242,
      port: 51_234,
      protocol: { major: 1, minor: 0 },
      capabilities: ['events.replay.v1', 'runtime.lifecycle.v1'],
      hostVersion: '2026.08.10.1',
      payloadHash: 'abc123',
      configIdentity: 'identity-1',
      runtimeChannel: 'development',
      hostInstanceId: 'host-1',
      hostGeneration: 'generation-1',
      startedAt: HostDebugFixtures.nowConst - 3_600_000,
      processStartedAt: HostDebugFixtures.nowConst - 3_600_500,
    }
  }

  static row(overrides: Partial<HostDebugRuntimeRow> = {}): HostDebugRuntimeRow {
    return {
      runtimeSessionId: 'live-1',
      sessionTitle: null,
      orphan: false,
      alive: true,
      pid: 5_000,
      generation: 1,
      startedAt: HostDebugFixtures.nowConst - 120_000,
      exitedAt: null,
      exitCode: null,
      exitReason: null,
      outputSeq: 7,
      lastOutputAt: HostDebugFixtures.nowConst - 5_000,
      work: null,
      ...overrides,
    }
  }
}
