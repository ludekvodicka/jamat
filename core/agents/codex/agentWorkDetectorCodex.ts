import { AgentWorkDetectorBase } from '../workDetection/agentWorkDetectorBase.js'
import type {
  AgentWorkEvidence,
  AgentWorkFrame,
  AgentWorkInspection,
  AgentWorkInspectionMode,
} from '../workDetection/agentWorkDetector.types.js'

export class AgentWorkDetectorCodex extends AgentWorkDetectorBase {
  readonly agent = 'codex' as const

  private static readonly WORKING_SCREEN = /(?:^|\n)\s*[›❯>]\s+working\s+\(\s*(?:\d+\s*(?:h|m|s)\s*)+[•·]\s*esc\s+to\s+interrupt\s*\)\s*(?:\n|$)/i
  private static readonly WORKING_RAW = /[›❯>]working\((?:\d+(?:h|m|s))+[•·]esctointerrupt\)/

  protected inspect(frame: AgentWorkFrame, mode: AgentWorkInspectionMode): AgentWorkInspection {
    const evidence: AgentWorkEvidence[] = []
    const modeConfig = AgentWorkDetectorCodex.modeConfig(mode)
    if (modeConfig.includeRaw) {
      const raw = AgentWorkDetectorBase.normalizeTty(frame.rawTail).match(AgentWorkDetectorCodex.WORKING_RAW)?.[0]
      if (raw) evidence.push({ source: 'raw', signal: 'workingRow', match: raw })
    }
    const screen = AgentWorkDetectorBase.stripAnsiLower(frame.screenTail).match(AgentWorkDetectorCodex.WORKING_SCREEN)?.[0]
    if (screen) evidence.push({ source: 'screen', signal: 'workingRow', match: screen.trim() })
    if (!evidence.length && modeConfig.outputActivity && AgentWorkDetectorBase.stripAnsiLower(frame.rawTail).trim())
      evidence.push({ source: 'raw', signal: 'outputActivity', match: 'pty-output' })
    return { hint: evidence.length ? 'working' : 'unknown', evidence, backgroundActivity: false }
  }

  private static modeConfig(mode: AgentWorkInspectionMode): { includeRaw: boolean; outputActivity: boolean } {
    if (mode === 'output') return { includeRaw: true, outputActivity: true }
    else if (mode === 'rendered') return { includeRaw: true, outputActivity: false }
    else if (mode === 'settled') return { includeRaw: false, outputActivity: false }
    else
      throw new Error(`Unknown inspection mode: ${JSON.stringify(mode)}`)
  }
}
