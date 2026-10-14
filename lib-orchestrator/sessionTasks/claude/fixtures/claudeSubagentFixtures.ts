/**
 * Sub-agent transcript lines in the shapes Claude Code 2.1.x writes into
 * `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl`, and the metas beside them.
 *
 * `realAgent` is cut from `agent-ac219003d875267a2` of a planning session: its records in their
 * order and with their fields, the long texts shortened and the environment details left out.
 */
export class ClaudeSubagentFixtures {
  static readonly realAgentIdConst = 'ac219003d875267a2'

  static readonly realAgentMetaConst = {
    agentType: 'pp:research:repo-research-analyst',
    description: 'Jamat transcript readers research',
    toolUseId: 'toolu_01Rtz4u7diSCgy161uSRKWy9',
    spawnDepth: 1,
    requestShape: 'background',
    requestNonInteractive: true,
  }

  /** Prompt, attachments, a thinking turn, a `Bash` call and its result, and the final `end_turn`. */
  static realAgent(): string {
    const agentId = ClaudeSubagentFixtures.realAgentIdConst
    return [
      ClaudeSubagentFixtures.prompt(
        'Mode: read only. Do not edit files. Return findings as your final message.\n\nProject: Q:\\Applications\\ProductivityTools\\Jamat (AppJamatV3).',
        '2026-10-12T06:01:52.660Z',
        agentId,
      ),
      ClaudeSubagentFixtures.attachment('2026-10-12T06:01:52.674Z', agentId),
      ClaudeSubagentFixtures.thinking('2026-10-12T06:04:44.053Z', agentId),
      ClaudeSubagentFixtures.toolUse('Bash', {
        command: 'cd /q/Applications/ProductivityTools/Jamat/app-client-ui && cat -n app/shared/agentSessionContext.ts | sed -n 1,60p',
        description: 'Read AgentSessionContext gate',
      }, '2026-10-12T06:04:44.774Z', agentId),
      ClaudeSubagentFixtures.toolResult('     1\timport type {', '2026-10-12T06:04:44.934Z', agentId),
      ClaudeSubagentFixtures.attachment('2026-10-12T06:04:44.938Z', agentId),
      ClaudeSubagentFixtures.thinking('2026-10-12T06:04:53.376Z', agentId),
      ClaudeSubagentFixtures.finalText(
        '**Summary:** Jamat has no code yet that lists, watches or draws a session\'s sub-agents.',
        '2026-10-12T06:05:50.708Z',
        agentId,
      ),
    ].join('')
  }

  /** The first record: the whole prompt as one string. */
  static prompt(text: string, at = '2026-10-12T06:00:00.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      parentUuid: null,
      isSidechain: true,
      agentId,
      type: 'user',
      message: { role: 'user', content: text },
      timestamp: at,
    })
  }

  static attachment(at = '2026-10-12T06:00:01.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      attachment: { type: 'date', date: '2026-10-12' },
      type: 'attachment',
      timestamp: at,
    })
  }

  /** A turn still thinking: its signature only, no stop reason yet. */
  static thinking(at = '2026-10-12T06:00:02.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'CAQS' }],
        stop_reason: null,
      },
      timestamp: at,
    })
  }

  static toolUse(
    name: string,
    input: Record<string, unknown>,
    at = '2026-10-12T06:00:03.000Z',
    agentId = 'a0000000000000001',
  ): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01Uo4RhfYZ3kw5ukosg7WyVz', name, input, caller: { type: 'direct' } }],
        stop_reason: 'tool_use',
      },
      timestamp: at,
    })
  }

  static toolResult(text: string, at = '2026-10-12T06:00:04.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu_01Uo4RhfYZ3kw5ukosg7WyVz', type: 'tool_result', content: text, is_error: false }],
      },
      timestamp: at,
    })
  }

  static finalText(text: string, at = '2026-10-12T06:00:05.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 30_000, output_tokens: 410 },
      },
      timestamp: at,
    })
  }

  /** What Claude Code writes when the person stops the agent: `[Request interrupted by user]`, or `... for tool use]`. */
  static interrupted(text: string, at = '2026-10-12T06:00:06.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      timestamp: at,
    })
  }

  /** The synthetic turn of a refused request, as a sub-agent that hit its rate limit ended. */
  static apiError(at = '2026-10-12T06:00:07.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: {
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'You\'ve hit your session limit' }],
        stop_reason: 'stop_sequence',
      },
      timestamp: at,
    })
  }

  /** A tool call under its own id, so a test can pair several calls with their results. */
  static toolCall(
    id: string,
    name: string,
    input: Record<string, unknown>,
    at = '2026-10-12T06:00:03.000Z',
    agentId = 'a0000000000000001',
  ): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
        stop_reason: 'tool_use',
      },
      timestamp: at,
    })
  }

  /** The result of `toolCall(id, ...)`; an Edit's carries the patch Claude Code records beside it. */
  static toolOutcome(
    id: string,
    text: string,
    options: { isError?: boolean; toolUseResult?: Record<string, unknown>; at?: string } = {},
    agentId = 'a0000000000000001',
  ): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: id, type: 'tool_result', content: text, is_error: options.isError ?? false }],
      },
      ...(options.toolUseResult === undefined ? {} : { toolUseResult: options.toolUseResult }),
      timestamp: options.at ?? '2026-10-12T06:00:04.000Z',
    })
  }

  static compactBoundary(at = '2026-10-12T06:00:08.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      parentUuid: null,
      isSidechain: true,
      agentId,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      timestamp: at,
      compactMetadata: { trigger: 'auto', preTokens: 96_700 },
    })
  }

  /** The summary Claude Code writes after a compaction, as a user turn the agent did not receive from anyone. */
  static compactSummary(at = '2026-10-12T06:00:09.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      type: 'user',
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      timestamp: at,
    })
  }

  /** A message the coordinator sent the running agent. */
  static queuedCommand(prompt: string, at = '2026-10-12T06:00:10.000Z', agentId = 'a0000000000000001'): string {
    return ClaudeSubagentFixtures.line({
      isSidechain: true,
      agentId,
      attachment: { type: 'queued_command', prompt, origin: { kind: 'coordinator' }, isMeta: true },
      type: 'attachment',
      timestamp: at,
    })
  }

  private static line(record: Record<string, unknown>): string {
    return `${JSON.stringify(record)}\n`
  }
}
