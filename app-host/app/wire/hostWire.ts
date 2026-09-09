export class HostWireConst {
  /**
   * Wire numbering restarts for V3. V2-era clients are unreachable by construction (this host
   * uses a separate machine-state root and config directory), so continuity would have no
   * consumer. The restart is also an active fence: a stray V2-era client requires major 3,
   * sees 1, and refuses loudly instead of half-working.
   */
  static readonly protocolMajor = 1
  static readonly protocolMinor = 0

  static readonly capabilities = [
    'controller-lease.v1',
    'events.replay.v1',
    'runtime.lifecycle.v1',
    'runtime.mutation-fence.v1',
    'terminal.backpressure.v1',
    'terminal.replay.v1',
    'terminal.screen.v1',
    'terminal.snapshot.v1',
  ] as const

  static readonly runtimeChannels = ['production', 'development'] as const

  static readonly wsErrorCodes = [
    'bad-request',
    'conflict',
    'controller-required',
    'not-writer',
    'unknown-runtime',
  ] as const

  /** Every op the Host answers, with the access class the transport enforces. */
  static readonly ops = {
    'controller.acquire': 'rw',
    'controller.renew': 'rw',
    'controller.release': 'rw',
    'runtime.create': 'rw',
    'runtime.inspect': 'ro',
    'runtime.list': 'ro',
    'runtime.remove': 'rw',
    'runtime.replace': 'rw',
    'runtime.stop': 'rw',
    'host.stop': 'rw',
  } as const

  static readonly maxInputBytes = 4_096
  static readonly maxOpBodyBytes = 64 * 1_024
  static readonly maxControllerLeaseTtlMs = 30_000
  static readonly defaultControllerLeaseTtlMs = 15_000
}

export type RuntimeChannel = typeof HostWireConst.runtimeChannels[number]

export function isRuntimeChannel(value: unknown): value is RuntimeChannel {
  return typeof value === 'string'
    && (HostWireConst.runtimeChannels as readonly string[]).includes(value)
}

export interface WireVersion {
  major: number
  minor: number
}

export interface BuildInfo {
  buildVersion: string
  releaseVersion?: string
  sourceRevision: string
  platform: string
  arch: string
  hostWire: WireVersion
  capabilities: string[]
  payloadHash: string
}

export interface HostProcessRef {
  hostInstanceId: string
  pid: number
  processStartedAt: number
  payloadHash: string
}

export interface HostDescriptor {
  schemaVersion: 1
  pid: number
  processStartedAt: number
  port: number
  token: string
  protocol: WireVersion
  capabilities: string[]
  hostVersion: string
  payloadHash: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
  hostInstanceId: string
  hostGeneration: string
  startedAt: number
}

export interface HostHello {
  app: 'jamat-host'
  protocol: WireVersion
  capabilities: string[]
  buildInfo: BuildInfo
  configIdentity: string
  runtimeChannel: RuntimeChannel
  hostGeneration: string
  process: HostProcessRef
  runtimes: { live: number; dead: number }
  eventRevision: number
}

export interface RuntimeRef {
  hostInstanceId: string
  runtimeSessionId: string
  generation: number
}

/**
 * The complete launch. `env` is the final child environment: the Host adds nothing of its own
 * and inherits nothing into it. The Host stores only a canonical request digest for replay,
 * never argv or environment contents.
 */
export interface RuntimeLaunchSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface RuntimeSessionInfo {
  runtimeSessionId: string
  generation: number
  alive: boolean
  pid?: number
  processStartedAt?: number
  cols: number
  rows: number
  outputSeq: number
  outputEpoch: number
  lastOutputAt: number | null
  startedAt: number
  exitedAt?: number
  exitCode?: number
  exitReason?: 'process-exit' | 'stopped' | 'host-lost' | 'spawn-failed'
}

export interface TerminalProjectionSnapshot {
  runtimeSessionId: string
  generation: number
  outputEpoch: number
  outputSeq: number
  raw: string
  screen: string
  cols: number
  rows: number
  alive: boolean
  lastOutputAt: number | null
}

export interface RuntimeCreateReq {
  controllerLeaseId: string
  operationId: string
  runtimeSessionId: string
  launch: RuntimeLaunchSpec
}

export interface RuntimeTargetReq {
  target: RuntimeRef
}

export interface RuntimeTargetMutationReq extends RuntimeTargetReq {
  controllerLeaseId: string
}

export interface RuntimeReplaceReq extends RuntimeTargetMutationReq {
  operationId: string
  launch: RuntimeLaunchSpec
}

export type RuntimeInspectReq = RuntimeTargetReq

export interface RuntimeListResult {
  sessions: RuntimeSessionInfo[]
  throughRevision: number
  /** See `RuntimeResult.hostInstanceId`: a list is read to decide a later mutation. */
  hostInstanceId: string
}

export interface RuntimeResult {
  session: RuntimeSessionInfo
  /**
   * The Host that served this create or replace. The client compares it with the descriptor captured for
   * the request; all runtime calls then expose that captured process identity through `HostAnswer`.
   */
  hostInstanceId: string
}

export type RuntimeMutationDiagnostic =
  | 'stopped'
  | 'removed'
  | 'already-dead'
  | 'already-removed'
  | 'superseded'

export interface RuntimeMutationAck {
  servedByHostInstanceId: string
  target: RuntimeRef
  diagnostic: RuntimeMutationDiagnostic
}

export interface RuntimeInspectResult {
  session: RuntimeSessionInfo
  projection: TerminalProjectionSnapshot | null
}

export interface ControllerLeaseAcquireReq {
  controllerId: string
  ttlMs?: number
}

export interface ControllerLeaseMutationReq {
  controllerLeaseId: string
  ttlMs?: number
}

export interface ControllerLeaseResult {
  controllerLeaseId: string
  controllerId: string
  expiresAt: number
}

export interface HostStopReq {
  controllerLeaseId: string
  force?: boolean
}

export type HostOpName = keyof typeof HostWireConst.ops

export function isHostOpName(value: unknown): value is HostOpName {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(HostWireConst.ops, value)
}

export function isReadOnlyOp(name: HostOpName): boolean {
  return HostWireConst.ops[name] === 'ro'
}

export type HostEventPayload =
  | { kind: 'runtime-created'; session: RuntimeSessionInfo }
  | { kind: 'runtime-replaced'; session: RuntimeSessionInfo }
  | { kind: 'runtime-exited'; session: RuntimeSessionInfo }
  | { kind: 'runtime-removed'; runtimeSessionId: string }
  | { kind: 'host-stopping' }

export type HostEvent = HostEventPayload & {
  revision: number
  timestamp: number
}

export type HostWsClientMsg =
  | {
      type: 'terminal.attach'
      target: RuntimeRef
      controllerLeaseId?: string
      role?: 'interactive' | 'observer'
      outputEpoch?: number
      sinceSeq?: number
      cols?: number
      rows?: number
    }
  | { type: 'terminal.detach' }
  | { type: 'terminal.input'; data: string }
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'events.subscribe'; afterRevision?: number }

export type HostWsServerMsg =
  | { type: 'terminal.attached'; writer: boolean; session: RuntimeSessionInfo }
  | { type: 'terminal.snapshot'; projection: TerminalProjectionSnapshot }
  | {
      type: 'terminal.delta'
      runtimeSessionId: string
      generation: number
      outputEpoch: number
      data: string
      outputSeq: number
      truncated: boolean
    }
  | {
      type: 'terminal.data'
      runtimeSessionId: string
      generation: number
      outputEpoch: number
      delta: string
      outputSeq: number
      lastOutputAt: number
    }
  | {
      type: 'terminal.resize'
      runtimeSessionId: string
      generation: number
      cols: number
      rows: number
    }
  | {
      type: 'terminal.exit'
      runtimeSessionId: string
      generation: number
      exitCode: number
    }
  | {
      type: 'terminal.stream-truncated'
      runtimeSessionId: string
      generation: number
      outputEpoch: number
      outputSeq: number
    }
  | { type: 'events.subscribed'; throughRevision: number; replay: HostEvent[]; truncated: boolean }
  | { type: 'event'; event: HostEvent }
  | { type: 'error'; code: HostWsErrorCode; message: string }

export type HostWsErrorCode = typeof HostWireConst.wsErrorCodes[number]
