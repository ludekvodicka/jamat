import type {
  AgentWorkEvidence,
  AgentWorkEvidenceSource,
  AgentWorkFrame,
  AgentWorkInspection,
} from './agentWorkInspector.types'
import { ScreenTail } from './screenTail'

/**
 * Classifies one Antigravity (`agy`) terminal frame.
 *
 * Follows the work-state inspector discipline: every matched pattern names the recorded live fixture
 * that admits it (`antigravity-live-working.json`, `antigravity-live-background-tasks.json`,
 * `antigravity-live-background-subagents.json`, `antigravity-live-permission-prompt.json`,
 * `antigravity-live-trust-dialog.json`, `antigravity-live-idle.json`), and only the rendered screen
 * is read for active work (never the raw ring).
 */
export class AgentWorkInspectorAntigravity {
  /**
   * `antigravity-live-permission-prompt.json` (`Requesting permission for:`, `Run this command?`)
   * and `antigravity-live-trust-dialog.json` (`Do you trust the contents of this project?`,
   * `Yes, I trust this folder`), matched on normalized text so cursor-forward spaces and line
   * wrapping never break them.
   */
  private static readonly blockedWordingConst = [
    /requestingpermissionfor:/,
    /runthiscommand\?/,
    /doyoutrustthecontentsofthisproject\?/,
    /itrustthisfolder/,
  ] as const

  /**
   * `antigravity-live-permission-prompt.json`: selected approval option (`> 1. Yes, run command`).
   * Collision-prone on its own (an echoed user message starting with `1. Yes`), so it requires
   * corroboration by a wording or menu-footer signal.
   */
  private static readonly selectedYesConst = /[>❯]\d+\.yes\b/

  /**
   * `antigravity-live-permission-prompt.json` (`↑/↓ Navigate · tab Amend · ctrl+g edit/expand
   * command`) and `antigravity-live-trust-dialog.json` (`↑/↓ Navigate · enter Confirm`).
   * Deliberately omits bare `esc to cancel`, because Antigravity draws `esc to cancel` under the
   * composer box while working (`antigravity-live-working.json`).
   */
  private static readonly menuFooterConst = [
    /↑\/↓(?:to)?navigate/,
    /tabamend/,
    /ctrl\+gedit/,
    /enterconfirm/,
  ] as const

  /** Selected option row (`> 1. ...`). Never decides on its own; see `rowSignalsConst`. */
  private static readonly selectedRowConst = /[>❯]\d+\./

  /** Row-only signals that require corroboration by wording or a menu footer. */
  private static readonly rowSignalsConst: readonly string[] = ['selectedRow', 'selectedYes']

  /**
   * `antigravity-live-working.json`: a braille spinner row (`⣾  Running command...`) drawn directly
   * above the top horizontal rule of the composer box.
   */
  private static readonly spinnerAboveRuleConst =
    /(?:^|\n)[ \t]*[\u2800-\u28ff][ \t]+[^\n]+(?=\n─{8,})/

  /** Horizontal rule delimiting the composer box and optional background-task drawer. */
  private static readonly ruleRowConst = /^─{8,}/

  /** Composer prompt line opening directly under the box's top rule. */
  private static readonly promptMarkerRowConst = /^[>❯]/

  /**
   * `antigravity-live-working.json`: `esc to cancel` at the start of the footer row directly beneath
   * a closed ruled composer box (and optional task drawer) at the bottom of the screen.
   */
  private static readonly workingFooterNormConst = /^esctocancel/

  /**
   * `antigravity-live-idle.json` and `antigravity-live-background-tasks.json`: `? for shortcuts` at
   * the start of the footer row directly beneath a closed ruled composer box (and optional task
   * drawer) at the bottom of the screen.
   */
  private static readonly idleFooterNormConst = /^\?forshortcuts/

  /**
   * `antigravity-live-background-tasks.json`: active task count in the footer (`· 1 task(s) · /tasks`)
   * beneath a closed composer box. Requires a positive count so `0 task(s)` never counts as active.
   */
  private static readonly backgroundTasksFooterNormConst = /·[1-9]\d*task(?:\(s\)|s?)(?:·\/tasks|·|$)/

  /**
   * `antigravity-live-background-subagents.json`: active subagent count in the footer
   * (`· 1 subagent(s)`) beneath a closed composer box. Requires a positive count so `0 subagent(s)`
   * never counts as active.
   */
  private static readonly backgroundSubagentsFooterNormConst = /·[1-9]\d*subagent(?:\(s\)|s?)(?:·|$)/

  /**
   * `antigravity-live-background-tasks.json`: a running task row (`● [10:08:11] cmd... running`)
   * drawn inside the ruled drawer directly between the composer bottom rule and the footer rule.
   */
  private static readonly backgroundTaskRowNormConst = /^[●•◦○]\[\d{2}:\d{2}:\d{2}\].*running$/

  /**
   * `antigravity-live-background-subagents.json`: a running subagent row
   * (`● Agent(self: Group 3 Worker (U6-U9)) · Gemini 4 Neon  Generating · 9m15s`) drawn inside the
   * ruled drawer directly between the composer bottom rule and the footer rule.
   */
  private static readonly backgroundSubagentRowNormConst =
    /^[●•◦○]agent\(.+·(?:\d+h(?:\d+m)?(?:\d+s)?|\d+m(?:\d+s)?|\d+s)$/

  /** Explicit terminal status label right before the elapsed counter inside a subagent drawer row. */
  private static readonly finishedSubagentRowConst =
    /\s{2}(?:done|completed|failed|stopped|cancel(?:led|ed))\s*·/i

  /** Maximum rows in the background-task drawer between the composer rule and the footer rule. */
  private static readonly maxDrawerRowsConst = 8

  /** Up to two trailing rows allowed beneath the built-in footer for a stacked custom statusLine. */
  private static readonly maxStackedFooterRowsConst = 2

  static inspect(frame: AgentWorkFrame): AgentWorkInspection {
    const windows: readonly (readonly [AgentWorkEvidenceSource, string])[] = [
      ['screen', ScreenTail.stripAnsiLower(frame.screenTail)],
      ['wide-screen', ScreenTail.stripAnsiLower(frame.wideScreenTail)],
    ]
    const working: AgentWorkEvidence[] = []
    const background: AgentWorkEvidence[] = []
    const idle: AgentWorkEvidence[] = []
    let hasLiveComposer = false
    for (const [source, text] of windows) {
      const spinner = text.match(AgentWorkInspectorAntigravity.spinnerAboveRuleConst)?.[0]
      if (spinner) working.push({ source, signal: 'spinnerAboveRule', match: spinner.trim() })
      const layout = AgentWorkInspectorAntigravity.composerLayout(text)
      if (layout !== null) {
        hasLiveComposer = true
        if (layout.footerKind === 'working')
          working.push({ source, signal: 'composerEscToCancel', match: 'esc to cancel' })
        else
          idle.push({ source, signal: 'composerIdleFooter', match: '? for shortcuts' })
        const footerTasks = layout.normFooter.match(AgentWorkInspectorAntigravity.backgroundTasksFooterNormConst)?.[0]
        if (footerTasks)
          background.push({ source, signal: 'backgroundTasksFooter', match: footerTasks })
        const footerSubagents = layout.normFooter.match(AgentWorkInspectorAntigravity.backgroundSubagentsFooterNormConst)?.[0]
        if (footerSubagents)
          background.push({ source, signal: 'backgroundSubagentsFooter', match: footerSubagents })
        for (const row of layout.drawerRows) {
          const normRow = row.replace(/\s+/g, '')
          if (AgentWorkInspectorAntigravity.backgroundTaskRowNormConst.test(normRow))
            background.push({ source, signal: 'backgroundTaskRow', match: row.trim() })
          else if (AgentWorkInspectorAntigravity.backgroundSubagentRowNormConst.test(normRow)
            && !AgentWorkInspectorAntigravity.finishedSubagentRowConst.test(row))
            background.push({ source, signal: 'backgroundSubagentRow', match: row.trim() })
        }
      }
    }
    // Antigravity replaces the composer box with its permission/selection prompt, so a closed
    // composer at the bottom of the screen proves any prompt wording above it is quoted prose.
    if (!hasLiveComposer) {
      const prompt = AgentWorkInspectorAntigravity.promptEvidence(frame)
      if (prompt.blocked.length > 0) return { hint: 'blocked', evidence: prompt.blocked }
      if (prompt.waiting.length > 0) return { hint: 'waiting', evidence: prompt.waiting }
    }
    if (working.length > 0) return { hint: 'working', evidence: working }
    if (background.length > 0) return { hint: 'background', evidence: background }
    if (idle.length > 0) return { hint: 'idle', evidence: idle }
    return { hint: 'unknown', evidence: [] }
  }

  /**
   * Locates a closed composer box at the bottom of the screen, with an optional ruled background-task
   * drawer between the composer bottom rule and the footer row.
   */
  private static composerLayout(text: string): {
    footerKind: 'working' | 'idle'
    normFooter: string
    drawerRows: readonly string[]
  } | null {
    const rows = text.split('\n')
    const minFooter = Math.max(1, rows.length - 1 - AgentWorkInspectorAntigravity.maxStackedFooterRowsConst)
    for (let footerIndex = rows.length - 1; footerIndex >= minFooter; footerIndex -= 1) {
      const normFooter = rows[footerIndex].replace(/\s+/g, '')
      const footerKind = AgentWorkInspectorAntigravity.workingFooterNormConst.test(normFooter)
        ? 'working'
        : AgentWorkInspectorAntigravity.idleFooterNormConst.test(normFooter)
          ? 'idle'
          : null
      if (footerKind === null) continue
      const aboveFooterRule = footerIndex - 1
      if (!AgentWorkInspectorAntigravity.ruleRowConst.test(rows[aboveFooterRule])) continue
      if (AgentWorkInspectorAntigravity.findComposerTopRule(rows, aboveFooterRule) !== null)
        return { footerKind, normFooter, drawerRows: [] }
      const minBottomRule = Math.max(0, aboveFooterRule - 1 - AgentWorkInspectorAntigravity.maxDrawerRowsConst)
      for (let composerBottomRule = aboveFooterRule - 2; composerBottomRule >= minBottomRule; composerBottomRule -= 1) {
        if (!AgentWorkInspectorAntigravity.ruleRowConst.test(rows[composerBottomRule])) continue
        if (AgentWorkInspectorAntigravity.findComposerTopRule(rows, composerBottomRule) !== null)
          return {
            footerKind,
            normFooter,
            drawerRows: rows.slice(composerBottomRule + 1, aboveFooterRule),
          }
        break
      }
    }
    return null
  }

  /** Returns the top rule of a closed composer box ending at `bottomRule`, or null if none sits above it. */
  private static findComposerTopRule(rows: readonly string[], bottomRule: number): number | null {
    for (let index = bottomRule - 1; index >= 0; index -= 1) {
      if (!AgentWorkInspectorAntigravity.ruleRowConst.test(rows[index])) continue
      return index + 1 < bottomRule && AgentWorkInspectorAntigravity.promptMarkerRowConst.test(rows[index + 1])
        ? index
        : null
    }
    return null
  }

  /**
   * Prompt pass over screen, wide-screen and raw windows. A real prompt always leaves evidence in
   * the shallow window (`screen`), and a bare selected row never decides without wording or footer
   * corroboration.
   */
  private static promptEvidence(frame: AgentWorkFrame): {
    blocked: AgentWorkEvidence[]
    waiting: AgentWorkEvidence[]
  } {
    const windows: readonly (readonly [AgentWorkEvidenceSource, string])[] = [
      ['screen', ScreenTail.normalizeTty(frame.screenTail)],
      ['wide-screen', ScreenTail.normalizeTty(frame.wideScreenTail)],
      ['raw', ScreenTail.normalizeTty(frame.rawTail)],
    ]
    const blocked: AgentWorkEvidence[] = []
    const waiting: AgentWorkEvidence[] = []
    for (const [source, text] of windows) {
      for (const pattern of AgentWorkInspectorAntigravity.blockedWordingConst)
        AgentWorkInspectorAntigravity.addEvidence(blocked, source, 'blockedPrompt', text, pattern)
      AgentWorkInspectorAntigravity.addEvidence(
        blocked, source, 'selectedYes', text, AgentWorkInspectorAntigravity.selectedYesConst)
      for (const pattern of AgentWorkInspectorAntigravity.menuFooterConst)
        AgentWorkInspectorAntigravity.addEvidence(waiting, source, 'menuFooter', text, pattern)
      AgentWorkInspectorAntigravity.addEvidence(
        waiting, source, 'selectedRow', text, AgentWorkInspectorAntigravity.selectedRowConst)
    }
    const decided = [...blocked, ...waiting].some((item) => item.source === 'screen')
    if (!decided) return { blocked: [], waiting: [] }
    const corroborated = [...blocked, ...waiting]
      .some((item) => !AgentWorkInspectorAntigravity.rowSignalsConst.includes(item.signal))
    if (!corroborated) return { blocked: [], waiting: [] }
    return { blocked, waiting }
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

  /** Whether an inspection verdict came solely from `fromStatusLine` rather than screen evidence. */
  static isStatusLineInspection(inspection: AgentWorkInspection): boolean {
    return inspection.evidence.length > 0
      && inspection.evidence.every((item) => item.signal.startsWith('statusLine'))
  }

  /**
   * Classifies live state reported by Antigravity's official `statusLine` JSON payload
   * (`agent_state`, `tool_confirmation_pending`, `task_count`, running `subagents`). Returns null
   * for transient boot/error states where screen inspection should decide.
   */
  static fromStatusLine(status: {
    agentState: string | null
    toolConfirmationPending: boolean
    taskCount?: number
    runningSubagents?: number
  }): AgentWorkInspection | null {
    if (status.toolConfirmationPending)
      return {
        hint: 'blocked',
        evidence: [{ source: 'screen', signal: 'statusLineToolConfirmation', match: 'tool_confirmation_pending' }],
      }
    if (status.agentState === 'reviewing')
      return {
        hint: 'waiting',
        evidence: [{ source: 'screen', signal: 'statusLineReviewing', match: 'reviewing' }],
      }
    if (status.agentState === 'working' || status.agentState === 'tool_use')
      return {
        hint: 'working',
        evidence: [{ source: 'screen', signal: 'statusLineWorking', match: status.agentState }],
      }
    const backgroundCount = (status.taskCount ?? 0) + (status.runningSubagents ?? 0)
    if (backgroundCount > 0 && (status.agentState === 'idle' || status.agentState === null))
      return {
        hint: 'background',
        evidence: [{ source: 'screen', signal: 'statusLineBackgroundTasks', match: `${backgroundCount} task(s)` }],
      }
    if (status.agentState === 'idle')
      return {
        hint: 'idle',
        evidence: [{ source: 'screen', signal: 'statusLineIdle', match: 'idle' }],
      }
    return null
  }

  /**
   * Combines rendered screen evidence with Antigravity's statusLine hint: blocking/waiting prompts
   * outrank everything, a visible foreground working or background-task screen outranks an idle or
   * stale working statusLine tick, and statusLine resolves an otherwise unrecognized screen to
   * working, background, or idle.
   */
  static mergeStatusLine(
    screen: AgentWorkInspection,
    status: AgentWorkInspection | null,
  ): AgentWorkInspection {
    if (status === null) return screen
    if (status.hint === 'blocked' || status.hint === 'waiting') return status
    if (screen.hint === 'blocked' || screen.hint === 'waiting') return screen
    if (screen.hint === 'working' || screen.hint === 'background') return screen
    return status
  }
}
