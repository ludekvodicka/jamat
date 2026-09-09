import type { AgentSettingsAgentId } from './agentSettings'

/**
 * One line of the model picker. Every field is a label on a value the CLI already understands;
 * nothing here is computed with, which is why a number in it can be wrong without anything
 * misbehaving. What a session actually runs on is read off that session's own transcript by
 * `SessionModelReader`, and that is the surface to believe.
 */
export interface AgentModelOption {
  /** Exactly what goes to `--model` / `-m`, and exactly what the picker stores in config.json. */
  id: string
  label: string
  /** An `alias` follows the newest model of its family; a `version` names one release. */
  kind: 'alias' | 'version'
  /** The window a session gets. For Claude the `[1m]` suffix is the only source of the million. */
  context: number
  /** Empty means the model takes no effort, and the select over it is disabled. */
  efforts: readonly string[]
  note?: string
}

/**
 * The models the settings tab offers, written down rather than enumerated.
 *
 * Both CLIs can list their models - Codex with `codex debug models`, Claude only over
 * `GET /v1/models` with the OAuth token Claude Code keeps for itself - and the product does neither.
 * A live catalog was planned and dropped on 2026-08-24, because the ids do not move: the Codex
 * catalog is identical across three CLI releases, and no Claude id changed while the effort lists
 * did. `pnpm dev:models` prints this list in the shape below, so a refresh is a paste.
 *
 * **The list is an OFFER, never a rule.** The field beside it stays free text: a model released
 * this morning is typeable today, and an id that leaves this list stays in config.json and keeps
 * working. Nothing validates a stored value against these entries.
 *
 * The two halves are not symmetric, and that is measured, not stylistic. Claude takes aliases
 * (`opus` resolves to the newest Opus) and warns without stopping when it does not recognise a
 * value. Codex has no aliases at all - `-m gpt-5.6` ends the run with a 400 - so every Codex entry
 * is an exact slug, and its efforts are the ones that model supports, because an unsupported level
 * is a 400 there too.
 */
export class AgentModels {
  /**
   * Measured 2026-08-24 against claude-code/2.1.241 and codex-cli 0.149.0. `pnpm dev:models`
   * reprints this block; the date and both versions come from the same run, the way
   * `agentPresets.ts` carries the versions its flags were measured against.
   */
  private static readonly claudeConst: readonly AgentModelOption[] = [
    { id: 'opus', label: 'Opus (newest)',
      kind: 'alias', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      note: 'always the newest Opus' },
    { id: 'opus[1m]', label: 'Opus (newest, 1M context)',
      kind: 'alias', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'sonnet', label: 'Sonnet (newest)',
      kind: 'alias', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      note: 'always the newest Sonnet' },
    { id: 'sonnet[1m]', label: 'Sonnet (newest, 1M context)',
      kind: 'alias', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'haiku', label: 'Haiku (newest)',
      kind: 'alias', context: 200_000,
      efforts: [],
      note: 'always the newest Haiku' },
    { id: 'fable', label: 'Fable (newest)',
      kind: 'alias', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      note: 'always the newest Fable' },
    { id: 'fable[1m]', label: 'Fable (newest, 1M context)',
      kind: 'alias', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-5', label: 'Claude Opus 5',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-5[1m]', label: 'Claude Opus 5 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-5[1m]', label: 'Claude Sonnet 5 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-fable-5', label: 'Claude Fable 5',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-fable-5[1m]', label: 'Claude Fable 5 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-4-7[1m]', label: 'Claude Opus 4.7 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-sonnet-4-6[1m]', label: 'Claude Sonnet 4.6 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-opus-4-6[1m]', label: 'Claude Opus 4.6 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5',
      kind: 'version', context: 200_000,
      efforts: ['low', 'medium', 'high'] },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',
      kind: 'version', context: 200_000,
      efforts: [] },
    { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5',
      kind: 'version', context: 200_000,
      efforts: [] },
    { id: 'claude-sonnet-4-5-20250929[1m]', label: 'Claude Sonnet 4.5 (1M context)',
      kind: 'version', context: 1_000_000,
      efforts: [] },
  ]

  /** `codex-auto-review` answers `visibility: hide` and is not a model anybody chooses. */
  private static readonly codexConst: readonly AgentModelOption[] = [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol',
      kind: 'version', context: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      note: 'Latest frontier agentic coding model.' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra',
      kind: 'version', context: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      note: 'Balanced agentic coding model for everyday work.' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna',
      kind: 'version', context: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      note: 'Fast and affordable agentic coding model.' },
    { id: 'gpt-5.5', label: 'GPT-5.5',
      kind: 'version', context: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      note: 'Frontier model for complex coding, research, and real-world work.' },
    { id: 'gpt-5.4', label: 'GPT-5.4',
      kind: 'version', context: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      note: 'Strong model for everyday coding.' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini',
      kind: 'version', context: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      note: 'Small, fast, and cost-efficient model for simpler coding tasks.' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark',
      kind: 'version', context: 128_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      note: 'Ultra-fast coding model.' },
  ]

  static optionsFor(agentId: AgentSettingsAgentId): readonly AgentModelOption[] {
    if (agentId === 'claude') return AgentModels.claudeConst
    else if (agentId === 'codex') return AgentModels.codexConst
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /** An exact id or nothing: a model that left the list simply shows no detail line. */
  static optionOf(agentId: AgentSettingsAgentId, id: string): AgentModelOption | undefined {
    return AgentModels.optionsFor(agentId).find((option) => option.id === id)
  }

  /**
   * What to offer when no model is chosen: the levels of this agent, in the order its own models
   * name them. The default the agent starts on is one of those models, and which one is its answer.
   */
  static effortsFor(agentId: AgentSettingsAgentId): readonly string[] {
    const levels: string[] = []
    for (const option of AgentModels.optionsFor(agentId))
      for (const effort of option.efforts)
        if (!levels.includes(effort)) levels.push(effort)
    return levels
  }
}
