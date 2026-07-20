export interface TerminalPromptTarget {
  write(data: string): void
  isWin32InputMode(): boolean
}

export class TerminalPromptSubmitter {
  private static readonly STANDARD_ENTER = '\r'
  private static readonly WIN32_ENTER = '\x1b[13;28;13;1;0;1_'
  private static readonly targets = new Map<string, TerminalPromptTarget>()

  static register(terminalId: string, target: TerminalPromptTarget): () => void {
    TerminalPromptSubmitter.targets.set(terminalId, target)
    return () => {
      if (TerminalPromptSubmitter.targets.get(terminalId) === target)
        TerminalPromptSubmitter.targets.delete(terminalId)
    }
  }

  static submit(terminalId: string, text: string): boolean {
    const target = TerminalPromptSubmitter.targets.get(terminalId)
    if (!target) return false
    target.write(text)
    target.write(TerminalPromptSubmitter.enterSequence(target.isWin32InputMode()))
    return true
  }

  private static enterSequence(win32InputMode: boolean): string {
    if (win32InputMode === false) return TerminalPromptSubmitter.STANDARD_ENTER
    else if (win32InputMode === true) return TerminalPromptSubmitter.WIN32_ENTER
    else
      throw new Error(`Unknown Win32 input mode: ${JSON.stringify(win32InputMode)}`)
  }
}
