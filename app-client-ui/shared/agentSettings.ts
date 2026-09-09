import type { SessionCreateSpec } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/**
 * Indexed access rather than a second literal union: the renderer already compiles
 * `sessionManagerApi.types`, so naming it here adds no new out-of-package target to the registry in
 * CLAUDE.md, and an agent added there cannot be forgotten here.
 */
export type AgentSettingsAgentId = NonNullable<SessionCreateSpec['agent']>['agentId']

export interface AgentSettingsAgentValue {
  yolo: boolean
  /**
   * Absent is a first-class value meaning "no opinion": no flag is emitted and the agent starts on
   * its own default, which both of them have and which a user may well have set themselves.
   */
  model?: string
  /** The same absence, for the reasoning level. Independent of `model`: either can stand alone. */
  effort?: string
  contextPanelPercent?: number
  autoCompactPercent?: number
  autoCompactEnabled?: boolean
}

export interface AgentContextCompactionSettings {
  panelPercent: number
  autoPercent: number
  enabled: boolean
}

export interface AgentSettingsValue {
  claude: AgentSettingsAgentValue
  codex: AgentSettingsAgentValue
}

export type AgentSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'section-damaged' | 'invalid-section'; detail: string }

export class AgentSettings {
  /**
   * Per agent, not one shared pair: the usage at which compacting is worth its cost differs between
   * the two, and a single default that suited one always sat wrong for the other.
   */
  private static readonly claudeCompactionDefaultConst: AgentContextCompactionSettings =
    { panelPercent: 35, autoPercent: 40, enabled: false }
  private static readonly codexCompactionDefaultConst: AgentContextCompactionSettings =
    { panelPercent: 60, autoPercent: 75, enabled: false }
  /**
   * Starts alphanumeric, never `-`, so a stored value can never be read as a flag by the CLI it is
   * handed to. The rest is the shape both catalogs use, plus the optional `[1m]` suffix Claude ids
   * carry. Spaces, `&`, `|` and `^` are out, so the value also survives the win32
   * `cmd /d /q /c <agent> ...` wrap every launch goes through. Aliases (`fable`, `opus`) pass as
   * well as full ids (`claude-fable-5`, `gpt-5.6-sol`); whether the model EXISTS is the agent's own
   * answer, never checked here.
   */
  private static readonly modelShapeConst = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9]+\])?$/
  /**
   * A bare word, and deliberately NOT a union of the levels anybody knows today: the two CLIs
   * disagree about them already (Codex takes `ultra`, Claude names low/medium/high/xhigh/max) and
   * a level added by an update would otherwise be unusable until this line changed. What the
   * shape rules out is a value that could be read as a flag or acted on by cmd.exe.
   */
  private static readonly effortShapeConst = /^[A-Za-z][A-Za-z0-9]*$/

  static defaultValue(): AgentSettingsValue {
    return { claude: { yolo: false }, codex: { yolo: false } }
  }

  static coerce(value: unknown, report: (message: string) => void): AgentSettingsValue {
    if (value === undefined) return AgentSettings.defaultValue()
    if (!AgentSettings.isRecord(value)) {
      report('The agents section of config.json is not an object; reading every agent as gated')
      return AgentSettings.defaultValue()
    }
    return {
      ...value,
      claude: AgentSettings.coerceAgent(value['claude'], 'claude', report),
      codex: AgentSettings.coerceAgent(value['codex'], 'codex', report),
    }
  }

  static isValid(value: unknown): value is AgentSettingsValue {
    if (!AgentSettings.isRecord(value)) return false
    return AgentSettings.isAgentValue(value['claude'], 'claude')
      && AgentSettings.isAgentValue(value['codex'], 'codex')
  }

  /**
   * Whether the raw value holds a hand edit its owner cannot read. An ABSENT entry is not one:
   * the store refuses a save only to protect something a person wrote and can still repair, and
   * filling in a missing agent throws nothing away. So an empty or partial section stays saveable
   * and only a present, unusable value latches this section.
   */
  static isDamaged(value: unknown): boolean {
    if (value === undefined) return false
    if (!AgentSettings.isRecord(value)) return true
    return AgentSettings.isAgentDamaged(value['claude'], 'claude')
      || AgentSettings.isAgentDamaged(value['codex'], 'codex')
  }

  static yoloFor(value: AgentSettingsValue, agentId: AgentSettingsAgentId): boolean {
    if (agentId === 'claude') return value.claude.yolo
    else if (agentId === 'codex') return value.codex.yolo
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  static withYolo(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
    yolo: boolean,
  ): AgentSettingsValue {
    if (agentId === 'claude') return { ...value, claude: { ...value.claude, yolo } }
    else if (agentId === 'codex') return { ...value, codex: { ...value.codex, yolo } }
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  static modelFor(value: AgentSettingsValue, agentId: AgentSettingsAgentId): string | undefined {
    if (agentId === 'claude') return value.claude.model
    else if (agentId === 'codex') return value.codex.model
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /**
   * `undefined` REMOVES the key rather than storing one: config.json is meant to hold the ABSENCE
   * of an opinion, and a null or an empty string would be a third state that nothing reads.
   */
  static withModel(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
    model: string | undefined,
  ): AgentSettingsValue {
    if (agentId === 'claude')
      return { ...value, claude: AgentSettings.agentWithModel(value.claude, model) }
    else if (agentId === 'codex')
      return { ...value, codex: AgentSettings.agentWithModel(value.codex, model) }
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  static effortFor(value: AgentSettingsValue, agentId: AgentSettingsAgentId): string | undefined {
    if (agentId === 'claude') return value.claude.effort
    else if (agentId === 'codex') return value.codex.effort
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  static contextCompactionFor(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
  ): AgentContextCompactionSettings {
    const agent = AgentSettings.agentFor(value, agentId)
    const defaults = AgentSettings.compactionDefaultsFor(agentId)
    return {
      panelPercent: agent.contextPanelPercent ?? defaults.panelPercent,
      autoPercent: agent.autoCompactPercent ?? defaults.autoPercent,
      enabled: agent.autoCompactEnabled ?? defaults.enabled,
    }
  }

  static withContextPanelPercent(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
    contextPanelPercent: number,
  ): AgentSettingsValue {
    return AgentSettings.withAgent(value, agentId, {
      ...AgentSettings.agentFor(value, agentId),
      contextPanelPercent,
    })
  }

  static withAutoCompactPercent(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
    autoCompactPercent: number,
  ): AgentSettingsValue {
    return AgentSettings.withAgent(value, agentId, {
      ...AgentSettings.agentFor(value, agentId),
      autoCompactPercent,
    })
  }

  static withAutoCompactEnabled(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
    autoCompactEnabled: boolean,
  ): AgentSettingsValue {
    return AgentSettings.withAgent(value, agentId, {
      ...AgentSettings.agentFor(value, agentId),
      autoCompactEnabled,
    })
  }

  /** `undefined` REMOVES the key, the same way `withModel` does and for the same reason. */
  static withEffort(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
    effort: string | undefined,
  ): AgentSettingsValue {
    if (agentId === 'claude')
      return { ...value, claude: AgentSettings.agentWithEffort(value.claude, effort) }
    else if (agentId === 'codex')
      return { ...value, codex: AgentSettings.agentWithEffort(value.codex, effort) }
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  private static agentWithEffort(
    agent: AgentSettingsAgentValue,
    effort: string | undefined,
  ): AgentSettingsAgentValue {
    const next: AgentSettingsAgentValue = { ...agent }
    if (effort === undefined) delete next.effort
    else next.effort = effort
    return next
  }

  private static agentWithModel(
    agent: AgentSettingsAgentValue,
    model: string | undefined,
  ): AgentSettingsAgentValue {
    const next: AgentSettingsAgentValue = { ...agent }
    if (model === undefined) delete next.model
    else next.model = model
    return next
  }

  /**
   * The fields this app owns, back to their defaults, and nothing else touched. `coerceAgent`
   * returns a usable entry exactly as it found it, so a key somebody hand-wrote INSIDE an agent
   * survives being read; a reset that replaced the whole entry took it away again at the next
   * save. A reset undoes what this app wrote, not what it never understood.
   */
  static resetAgents(value: AgentSettingsValue): AgentSettingsValue {
    const defaults = AgentSettings.defaultValue()
    return {
      ...value,
      claude: AgentSettings.resetAgent(value.claude, defaults.claude),
      codex: AgentSettings.resetAgent(value.codex, defaults.codex),
    }
  }

  /**
   * The defaults over the entry keep every key neither side names. An OPTIONAL field this app
   * owns has no default to overwrite it with, so it goes by name - every optional field added to
   * `AgentSettingsAgentValue` needs its line here, or a reset quietly leaves it standing.
   */
  private static resetAgent(
    agent: AgentSettingsAgentValue,
    defaults: AgentSettingsAgentValue,
  ): AgentSettingsAgentValue {
    const next: AgentSettingsAgentValue = { ...agent, ...defaults }
    delete next.model
    delete next.effort
    delete next.contextPanelPercent
    delete next.autoCompactPercent
    delete next.autoCompactEnabled
    return next
  }

  private static coerceAgent(
    value: unknown,
    agentId: AgentSettingsAgentId,
    report: (message: string) => void,
  ): AgentSettingsAgentValue {
    if (value === undefined) return { yolo: false }
    if (!AgentSettings.isRecord(value)) {
      report(`The agents section of config.json has an unusable ${agentId} entry `
        + `(${JSON.stringify(value)}); reading it as gated`)
      return { yolo: false }
    }
    if (AgentSettings.isAgentValue(value, agentId)) return value
    // Field by field, so one unusable value costs only itself: a hand edit that mistypes the model
    // must not also throw away the yolo switch its owner set on purpose, or the other way round.
    //
    // Unknown sibling keys are deliberately NOT carried through this branch, unlike the one above.
    // An entry that reaches here is damaged by definition, so the section is latched and this value
    // is only ever read from, never written back over the file the keys came from.
    const repaired: AgentSettingsAgentValue = {
      yolo: AgentSettings.coerceYolo(value['yolo'], agentId, report),
    }
    const model = AgentSettings.coerceModel(value['model'], agentId, report)
    if (model !== undefined) repaired.model = model
    const effort = AgentSettings.coerceEffort(value['effort'], agentId, report)
    if (effort !== undefined) repaired.effort = effort
    AgentSettings.coerceContextCompaction(value, repaired, agentId, report)
    return repaired
  }

  private static coerceContextCompaction(
    value: Record<string, unknown>,
    repaired: AgentSettingsAgentValue,
    agentId: AgentSettingsAgentId,
    report: (message: string) => void,
  ): void {
    const panel = AgentSettings.coercePercent(
      value['contextPanelPercent'], agentId, 'context panel', report)
    const auto = AgentSettings.coercePercent(
      value['autoCompactPercent'], agentId, 'auto-compact', report)
    const enabled = value['autoCompactEnabled']
    if (enabled !== undefined) {
      if (typeof enabled === 'boolean') repaired.autoCompactEnabled = enabled
      else
        report(`The agents section of config.json has an unusable ${agentId} auto-compact switch `
          + `(${JSON.stringify(enabled)}); reading it as disabled`)
    }
    const defaults = AgentSettings.compactionDefaultsFor(agentId)
    const effectivePanel = panel ?? defaults.panelPercent
    const effectiveAuto = auto ?? defaults.autoPercent
    if (effectivePanel > effectiveAuto) {
      report(`The agents section of config.json has ${agentId} context panel threshold `
        + `${effectivePanel} above auto-compact threshold ${effectiveAuto}; reading both as defaults`)
      return
    }
    if (panel !== undefined) repaired.contextPanelPercent = panel
    if (auto !== undefined) repaired.autoCompactPercent = auto
  }

  private static coercePercent(
    value: unknown,
    agentId: AgentSettingsAgentId,
    field: string,
    report: (message: string) => void,
  ): number | undefined {
    if (value === undefined) return undefined
    if (AgentSettings.isPercent(value)) return value
    report(`The agents section of config.json has an unusable ${agentId} ${field} threshold `
      + `(${JSON.stringify(value)}); reading its default`)
    return undefined
  }

  private static coerceYolo(
    value: unknown,
    agentId: AgentSettingsAgentId,
    report: (message: string) => void,
  ): boolean {
    if (typeof value === 'boolean') return value
    report(`The agents section of config.json has an unusable ${agentId} yolo `
      + `(${JSON.stringify(value)}); reading it as gated`)
    return false
  }

  private static coerceModel(
    value: unknown,
    agentId: AgentSettingsAgentId,
    report: (message: string) => void,
  ): string | undefined {
    if (value === undefined) return undefined
    if (AgentSettings.isModelValue(value)) return value
    report(`The agents section of config.json has an unusable ${agentId} model `
      + `(${JSON.stringify(value)}); reading it as no default model`)
    return undefined
  }

  private static coerceEffort(
    value: unknown,
    agentId: AgentSettingsAgentId,
    report: (message: string) => void,
  ): string | undefined {
    if (value === undefined) return undefined
    if (AgentSettings.isEffortValue(value)) return value
    report(`The agents section of config.json has an unusable ${agentId} effort `
      + `(${JSON.stringify(value)}); reading it as no default effort`)
    return undefined
  }

  private static isAgentDamaged(value: unknown, agentId: AgentSettingsAgentId): boolean {
    return value !== undefined && !AgentSettings.isAgentValue(value, agentId)
  }

  private static isAgentValue(
    value: unknown,
    agentId: AgentSettingsAgentId,
  ): value is AgentSettingsAgentValue {
    if (!AgentSettings.isRecord(value)) return false
    if (typeof value['yolo'] !== 'boolean') return false
    if (value['model'] !== undefined && !AgentSettings.isModelValue(value['model'])) return false
    if (value['effort'] !== undefined && !AgentSettings.isEffortValue(value['effort'])) return false
    if (value['contextPanelPercent'] !== undefined
      && !AgentSettings.isPercent(value['contextPanelPercent'])) return false
    if (value['autoCompactPercent'] !== undefined
      && !AgentSettings.isPercent(value['autoCompactPercent'])) return false
    if (value['autoCompactEnabled'] !== undefined
      && typeof value['autoCompactEnabled'] !== 'boolean') return false
    const defaults = AgentSettings.compactionDefaultsFor(agentId)
    return (value['contextPanelPercent'] ?? defaults.panelPercent)
      <= (value['autoCompactPercent'] ?? defaults.autoPercent)
  }

  private static isPercent(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100
  }

  private static isEffortValue(value: unknown): value is string {
    return typeof value === 'string' && AgentSettings.effortShapeConst.test(value)
  }

  private static isModelValue(value: unknown): value is string {
    return typeof value === 'string' && AgentSettings.modelShapeConst.test(value)
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  private static compactionDefaultsFor(
    agentId: AgentSettingsAgentId,
  ): AgentContextCompactionSettings {
    if (agentId === 'claude') return AgentSettings.claudeCompactionDefaultConst
    else if (agentId === 'codex') return AgentSettings.codexCompactionDefaultConst
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  private static agentFor(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
  ): AgentSettingsAgentValue {
    if (agentId === 'claude') return value.claude
    else if (agentId === 'codex') return value.codex
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  private static withAgent(
    value: AgentSettingsValue,
    agentId: AgentSettingsAgentId,
    agent: AgentSettingsAgentValue,
  ): AgentSettingsValue {
    if (agentId === 'claude') return { ...value, claude: agent }
    else if (agentId === 'codex') return { ...value, codex: agent }
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }
}
