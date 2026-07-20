import { AgentWorkDetectorBase } from '../workDetection/agentWorkDetectorBase.js'
import type {
  AgentWorkEvidence,
  AgentWorkEvidenceSource,
  AgentWorkFrame,
  AgentWorkInspection,
  AgentWorkInspectionMode,
} from '../workDetection/agentWorkDetector.types.js'

export class AgentWorkDetectorClaude extends AgentWorkDetectorBase {
  readonly agent = 'claude' as const

  private static readonly TOOL_USE = /⏺ (Read|Write|Edit|MultiEdit|Bash|Glob|Grep|Task|NotebookEdit|WebFetch|WebSearch|TodoWrite)\(/
  private static readonly BLOCKED = [
    /Do you want to (proceed|continue)/i,
    /\[y\/n\]/i,
    /Run \d+ shell command/i,
    /Press Enter to (continue|confirm)/i,
    /Allow this action\?/i,
    /❯ \d+\.\s+Yes\b/i,
  ] as const
  private static readonly QUESTION = /arrowkeystonavigate|esctocancel|↑\/↓tonavigate|❯\d+\./
  // Footer task counters that mean "turn is done, but something is still running in the background"
  // — a shell (`· 1 shell · …`) or a detached sub-agent (`· ← 1 agent · ↓ to manage`). Orthogonal to
  // the busy spinner: the prompt is idle and accepts input, yet the turn isn't truly finished.
  private static readonly BACKGROUND_TASK = /\b\d+\s+(?:shells?|agents?)\b/i
  private static readonly BUSY_COLLAPSED = [
    { signal: 'escToInterrupt', pattern: /esctointerrupt/ },
    { signal: 'tokenCounter', pattern: /[↑↓][\d.,]+k?tokens/ },
    { signal: 'elapsedDot', pattern: /\(\d+[hms](?:\d+[ms])*·/ },
    { signal: 'elapsedEllipsis', pattern: /(?:…|\.\.\.)\(\d+[hms]/ },
  ] as const
  private static readonly BUSY_WIDE = [
    { signal: 'elapsedDot', pattern: /\(\d+[hms](?:\d+[ms])*·/ },
    { signal: 'elapsedEllipsis', pattern: /(?:…|\.\.\.)\(\d+[hms]/ },
  ] as const
  private static readonly BUSY_SPACED = /(?:^|\s)[·*✦✧✶✷✸✹✺✻✼✽✢✣✤✥✱✲✳✴✵∗]\s+[a-z]+(?:…|\.\.\.)/i

  protected inspect(frame: AgentWorkFrame, mode: AgentWorkInspectionMode): AgentWorkInspection {
    const backgroundActivity = AgentWorkDetectorClaude.BACKGROUND_TASK.test(AgentWorkDetectorBase.stripAnsiLower(frame.screenTail))
    const blocked: AgentWorkEvidence[] = []
    for (const pattern of AgentWorkDetectorClaude.BLOCKED)
      AgentWorkDetectorClaude.addEvidence(blocked, 'raw', 'blockedPrompt', frame.rawTail, pattern)
    if (blocked.length) return { hint: 'blocked', evidence: blocked, backgroundActivity }

    const question: AgentWorkEvidence[] = []
    AgentWorkDetectorClaude.addEvidence(question, 'raw', 'questionMenu', AgentWorkDetectorBase.normalizeTty(frame.rawTail), AgentWorkDetectorClaude.QUESTION)
    if (question.length) return { hint: 'waiting', evidence: question, backgroundActivity }

    const includeRaw = AgentWorkDetectorClaude.modeIncludesRaw(mode)
    if (includeRaw) {
      const tool: AgentWorkEvidence[] = []
      AgentWorkDetectorClaude.addEvidence(tool, 'raw', 'toolUse', frame.rawTail, AgentWorkDetectorClaude.TOOL_USE)
      if (tool.length) return { hint: 'tool-use', evidence: tool, backgroundActivity }
    }

    const busy: AgentWorkEvidence[] = []
    if (includeRaw) AgentWorkDetectorClaude.addBusy(busy, 'raw', frame.rawTail)
    AgentWorkDetectorClaude.addBusy(busy, 'screen', frame.screenTail)
    const wide = AgentWorkDetectorBase.normalizeTty(frame.wideScreenTail)
    for (const item of AgentWorkDetectorClaude.BUSY_WIDE)
      AgentWorkDetectorClaude.addEvidence(busy, 'wide-screen', item.signal, wide, item.pattern)

    return { hint: busy.length ? 'working' : 'idle', evidence: busy, backgroundActivity }
  }

  private static addBusy(evidence: AgentWorkEvidence[], source: AgentWorkEvidenceSource, text: string): void {
    const collapsed = AgentWorkDetectorBase.normalizeTty(text)
    for (const item of AgentWorkDetectorClaude.BUSY_COLLAPSED)
      AgentWorkDetectorClaude.addEvidence(evidence, source, item.signal, collapsed, item.pattern)
    AgentWorkDetectorClaude.addEvidence(evidence, source, 'spinnerGlyph', AgentWorkDetectorBase.stripAnsiLower(text), AgentWorkDetectorClaude.BUSY_SPACED)
  }

  private static addEvidence(
    evidence: AgentWorkEvidence[],
    source: AgentWorkEvidenceSource,
    signal: string,
    text: string,
    pattern: RegExp,
  ): void {
    const match = text.match(pattern)?.[0]
    if (match) evidence.push({ source, signal, match: match.trim() })
  }

  private static modeIncludesRaw(mode: AgentWorkInspectionMode): boolean {
    if (mode === 'output') return true
    else if (mode === 'rendered') return true
    else if (mode === 'settled') return false
    else
      throw new Error(`Unknown inspection mode: ${JSON.stringify(mode)}`)
  }
}
