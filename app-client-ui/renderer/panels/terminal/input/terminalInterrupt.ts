import type { TerminalAgentId } from './terminalPromptNewline'

/** The unambiguous console record Codex reads for a physical bare Escape. */
export class TerminalInterrupt {
  private static readonly codexSequenceConst = '\x1b[27;1;27;1;0;1_'

  /** Whether these bytes are the sequence above rather than something a person typed into a line. */
  static isSequence(data: string): boolean {
    return data === TerminalInterrupt.codexSequenceConst
  }

  static sequenceOf(event: KeyboardEvent, agentId: TerminalAgentId | null): string | null {
    if (event.type !== 'keydown' || event.key !== 'Escape') return null
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null
    if (agentId === null || agentId === 'claude') return null
    else if (agentId === 'codex') return TerminalInterrupt.codexSequenceConst
    else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }
}
