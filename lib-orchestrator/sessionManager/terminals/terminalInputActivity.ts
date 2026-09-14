export class TerminalInputActivity {
  static isUserInput(data: string): boolean {
    if (data.length === 0) return false
    // xterm emits replies and focus/mouse reports through the same channel as keys.
    // Count text, control keys, bracketed paste and keyboard escape sequences only.
    if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) return true
    if (!data.includes('\x1b')) return true
    return /^\x1b(?:\[[0-9;]*[ABCDHF~]|\[[0-9;:]+u|O[ABCDHFP-S]|[^\[\]OPX^_])$/.test(data)
      || data === '\x1b'
  }
}
