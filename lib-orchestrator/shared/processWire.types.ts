import type { ControllerLeaseRelease } from '../hostClient/hostClient.types'
import type { EventEmitter } from 'node:events'
import type { OrchestratorBootstrap } from '../clientApi/orchestratorProcess.types'
import type { ServiceCaller, ServiceCallerGoneReason } from '../clientApi/serviceTransport.types'
import type { PerfBuild } from '../perfMonitor/perfRecord.types'
import type { RuntimeChannel } from './configIdentity.types'
import type { HostConnectionSnapshot } from '../hostClient/hostConnection'

export type ChildProcessKind = 'gateway' | 'orchestrator'
export interface ProcessIdentity { configIdentity: string; channel: RuntimeChannel; stateDirectory: string }
export type ProcessCallMessage =
  | { type: 'call'; id: number; target: string; method: string; args: unknown[] }
  | { type: 'pending'; id: number }
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'cancel'; id: number }
  | { type: 'received'; id: number }
  | { type: 'event'; target: string; name: string; payload: unknown }
export interface ProcessPowerMessage { type: 'power'; epoch: number; event: 'suspend' | 'resume' }
export type ProcessStoppedMessage =
  | { type: 'stopped'; process: 'orchestrator'; recordsSettled: boolean }
  | { type: 'stopped'; process: 'gateway'; leaseRelease: ControllerLeaseRelease }
export type ProcessMessage =
  | ProcessPowerMessage
  | ProcessCallMessage
  | { type: 'window-port'; windowId: string; epoch: string; accepting: boolean; caller?: ServiceCaller }
  | { type: 'window-accepting'; windowId: string; epoch: string; accepting: boolean }
  | { type: 'window-close'; windowId: string; epoch: string; reason?: ServiceCallerGoneReason }
  | { type: 'orchestrator-port' }
  | { type: 'host-connection'; value: HostConnectionSnapshot }
  | { type: 'hello'; build: PerfBuild; process: ChildProcessKind }
  | { type: 'initialize'; identity: ProcessIdentity; smoke?: boolean; bootstrap?: OrchestratorBootstrap }
  | { type: 'ready' }
  | { type: 'heartbeat'; seq: number }
  | { type: 'heartbeat-reply'; seq: number }
  // Utility to window only: a background-throttled renderer cannot keep a heartbeat cadence.
  | { type: 'alive' }
  | { type: 'startup-error'; error: string }
  | { type: 'stop' }
  | ProcessStoppedMessage

export type ProcessPort = Pick<EventEmitter, 'on'> & { postMessage(message: ProcessMessage): void; start(): void; close(): void }
