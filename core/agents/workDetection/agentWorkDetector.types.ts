import type { AgentId, AgentTerminalPhase, AgentWorkStatus } from '../../types/contracts.js'

export type { AgentTerminalPhase, AgentWorkStatus }
export type AgentWorkHint = 'working' | 'idle' | 'tool-use' | 'blocked' | 'waiting' | 'unknown'
export type AgentWorkVerdict = 'working' | 'idle' | 'unknown'
export type AgentWorkInspectionMode = 'output' | 'rendered' | 'settled'
export type AgentWorkEvidenceSource = 'raw' | 'screen' | 'wide-screen'
export type AgentWorkReason = 'evidence' | 'fast-idle' | 'silence' | 'tool-expiry' | 'process-exit' | 'reset'

export interface AgentWorkFrame {
  rawTail: string
  screenTail: string
  wideScreenTail: string
  phase: AgentTerminalPhase
  timestamp: number
}

export interface AgentWorkEvidence {
  source: AgentWorkEvidenceSource
  signal: string
  match: string
}

export interface AgentWorkInspection {
  hint: AgentWorkHint
  evidence: readonly AgentWorkEvidence[]
  backgroundActivity: boolean
}

export interface AgentWorkReport {
  agent: AgentId
  status: AgentWorkStatus
  active: boolean
  verdict: AgentWorkVerdict
  reason: AgentWorkReason
  evidence: readonly AgentWorkEvidence[]
  backgroundActivity: boolean
  timestamp: number
}

export interface AgentWorkDebugSnapshot {
  rawTail: string
  screenTail: string
  wideScreenTail: string
  report: AgentWorkReport
}

export interface AgentWorkDetectorCallbacks {
  readFrame(): AgentWorkFrame
  onStatus(status: AgentWorkStatus): void
  onBackgroundActivity(active: boolean): void
  onIdle(): void
  onReport(report: AgentWorkReport, frame: AgentWorkFrame): void
}

export type AgentWorkTimer = ReturnType<typeof setTimeout>

export interface AgentWorkDetectorScheduler {
  now(): number
  setTimeout(handler: () => void, delayMs: number): AgentWorkTimer
  clearTimeout(timer: AgentWorkTimer): void
}
