export interface ProviderTranscriptUserMessage {
  kind: 'explicit' | 'fallback'
  text: string
}

/**
 * The tags this reader branches on, and NOT the shapes behind them. `content` and `message` are
 * `unknown` on purpose: the rollout is another program's file and its own source says it
 * "tolerates schema churn", so a `content` that arrived as a string would meet `.map` here and
 * throw out of `listProjectSessions` - which its caller explicitly must not do, because that
 * would throw away the Claude listing beside it. One damaged rollout costs its own entry.
 */
interface CodexRecord {
  type?: string
  payload?: {
    type?: string
    role?: string
    content?: unknown
    message?: unknown
  }
}

export class ProviderTranscriptMessages {
  private static readonly injectedBlockPatternConst =
    /^<(environment_context|user_instructions)\b/i
  private static readonly agentsHeadingPatternConst = /^# AGENTS\.md instructions(?: for .+)?$/i
  private static readonly agentsBodyPatternConst = /\r?\n<INSTRUCTIONS>(?:\r?\n|$)/i

  static codex(record: unknown): ProviderTranscriptUserMessage | null {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null
    const value = record as CodexRecord
    if (value.type === 'event_msg' && value.payload?.type === 'user_message') {
      const message = value.payload.message
      const text = typeof message === 'string' ? message.trim() : null
      if (!text || ProviderTranscriptMessages.isInjected(text)) return null
      return { kind: 'explicit', text }
    }
    if (value.type === 'response_item'
      && value.payload?.type === 'message'
      && value.payload.role === 'user') {
      const text = ProviderTranscriptMessages.contentText(value.payload.content)
      if (!text || ProviderTranscriptMessages.isInjected(text)) return null
      return { kind: 'fallback', text }
    }
    return null
  }

  /** Each part contributes only what it actually holds; anything else contributes nothing. */
  private static contentText(content: unknown): string {
    if (!Array.isArray(content)) return ''
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const text = (part as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      })
      .join('')
      .trim()
  }

  static isCodexPromptBoundary(record: unknown): boolean {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false
    const value = record as CodexRecord
    if (value.type === 'response_item')
      return value.payload?.type === 'reasoning'
        || value.payload?.type === 'custom_tool_call'
        || (value.payload?.type === 'message' && value.payload.role === 'assistant')
    if (value.type === 'event_msg')
      return value.payload?.type === 'agent_message'
        || value.payload?.type === 'task_complete'
        || value.payload?.type === 'task_started'
    return false
  }

  private static isInjected(text: string): boolean {
    const trimmed = text.trimStart()
    if (ProviderTranscriptMessages.injectedBlockPatternConst.test(trimmed)) return true
    const firstLine = trimmed.split(/\r?\n/, 1)[0]
    return ProviderTranscriptMessages.agentsHeadingPatternConst.test(firstLine)
      && ProviderTranscriptMessages.agentsBodyPatternConst.test(trimmed)
  }
}
