import type { SessionShellCommandKind } from './sessionTasksApi.types'

/**
 * Classifies a background shell's full command by whether any command segment starts a coding agent,
 * matched against data lists of executables and driver scripts.
 */
export class ShellCommandKind {
  static readonly executablesConst: readonly string[] = ['claude', 'codex', 'agy', 'gemini']
  static readonly scriptsConst: readonly string[] = ['claude-run.mjs', 'codex-run.mjs', 'agy-run.mjs']
  private static readonly envAssignConst = /^[A-Za-z_][A-Za-z0-9_]*=/
  private static readonly extensionConst = /\.(?:exe|cmd|bat|ps1)$/

  static of(command: string): SessionShellCommandKind {
    return ShellCommandKind.matches(command, true) ? 'agent' : 'command'
  }

  private static matches(command: string, allowNested: boolean): boolean {
    return ShellCommandKind.segmentsOf(command).some((segment) =>
      ShellCommandKind.matchesSegment(segment, allowNested))
  }

  private static matchesSegment(segment: string, allowNested: boolean): boolean {
    const words = ShellCommandKind.wordsOf(segment)
    const resolved = ShellCommandKind.unwrapped(words, allowNested)
    if (resolved.kind === 'nested') return ShellCommandKind.matches(resolved.command, false)
    else if (resolved.kind !== 'words') throw new Error(`Unknown unwrapped command: ${JSON.stringify(resolved satisfies never)}`)
    const first = ShellCommandKind.baseOf(resolved.words[0])
    if (first === 'node') return ShellCommandKind.scriptsConst.includes(ShellCommandKind.baseOf(resolved.words[1]))
    return ShellCommandKind.executablesConst.includes(first)
  }

  /** Drops leading env assignments and known wrappers (`env`, `npx`, `pnpm exec|dlx`, `cmd /c`, `bash|sh -c`, `pwsh|powershell -Command`). */
  private static unwrapped(
    words: readonly string[],
    allowNested: boolean,
  ): { kind: 'words'; words: readonly string[] } | { kind: 'nested'; command: string } {
    let index = 0
    while (index < words.length) {
      const word = words[index]!
      if (ShellCommandKind.envAssignConst.test(word)) { index += 1; continue }
      const base = ShellCommandKind.baseOf(word)
      if (base === 'env') {
        index += 1
        while (index < words.length && words[index]!.startsWith('-')) {
          const flag = words[index]!
          index += flag === '-u' || flag === '--unset' ? 2 : 1
        }
        continue
      }
      if (base === 'npx') {
        index += 1
        while (index < words.length && words[index]!.startsWith('-')) index += 1
        continue
      }
      if (base === 'pnpm' && (words[index + 1] === 'exec' || words[index + 1] === 'dlx')) {
        index += 2
        continue
      }
      if (base === 'cmd' && words[index + 1]?.toLowerCase() === '/c') {
        const rest = words.slice(index + 2)
        if (allowNested && rest.length === 1) return { kind: 'nested', command: rest[0]! }
        index += 2
        continue
      }
      if (base === 'bash' || base === 'sh') {
        let cursor = index + 1
        while (cursor < words.length && words[cursor]!.startsWith('-')) {
          const flag = words[cursor]!
          if (/^-[a-z]*c$/i.test(flag)) {
            const inner = words[cursor + 1]
            if (allowNested && inner !== undefined) return { kind: 'nested', command: inner }
            break
          }
          cursor += 1
        }
        break
      }
      if (base === 'pwsh' || base === 'powershell') {
        let cursor = index + 1
        while (cursor < words.length && words[cursor]!.startsWith('-')) {
          const flag = words[cursor]!.toLowerCase()
          if (flag === '-command' || flag === '-c') {
            const rest = words.slice(cursor + 1)
            if (allowNested && rest.length > 0) return { kind: 'nested', command: rest.join(' ') }
            break
          }
          cursor += flag === '-executionpolicy' || flag === '-ep' ? 2 : 1
        }
        break
      }
      break
    }
    return { kind: 'words', words: words.slice(index) }
  }

  /** Splits on unquoted `&&`, `||`, `;`, `|` and newlines. */
  private static segmentsOf(command: string): string[] {
    const segments: string[] = []
    let start = 0
    let quote: '"' | "'" | null = null
    for (let index = 0; index < command.length; index += 1) {
      const ch = command[index]!
      if (quote !== null) {
        if (quote === '"' && ch === '\\' && command[index + 1] === '"') { index += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === '\n' || ch === '\r' || ch === ';') {
        ShellCommandKind.pushSegment(segments, command.slice(start, index))
        start = index + 1
      }
      else if (ch === '&' && command[index + 1] === '&') {
        ShellCommandKind.pushSegment(segments, command.slice(start, index))
        index += 1
        start = index + 1
      }
      else if (ch === '|') {
        ShellCommandKind.pushSegment(segments, command.slice(start, index))
        if (command[index + 1] === '|') index += 1
        start = index + 1
      }
    }
    ShellCommandKind.pushSegment(segments, command.slice(start))
    return segments
  }

  private static pushSegment(segments: string[], raw: string): void {
    const trimmed = raw.trim()
    if (trimmed !== '') segments.push(trimmed)
  }

  /** Splits one segment into shell words, stripping outer quotes while preserving Windows backslashes. */
  private static wordsOf(segment: string): string[] {
    const words: string[] = []
    let current = ''
    let inWord = false
    let quote: '"' | "'" | null = null
    for (let index = 0; index < segment.length; index += 1) {
      const ch = segment[index]!
      if (quote !== null) {
        if (quote === '"' && ch === '\\' && segment[index + 1] === '"') {
          current += '"'
          index += 1
        }
        else if (ch === quote) quote = null
        else current += ch
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue }
      if (ch === ' ' || ch === '\t') {
        if (inWord) { words.push(current); current = ''; inWord = false }
        continue
      }
      current += ch
      inWord = true
    }
    if (inWord) words.push(current)
    return words
  }

  private static baseOf(word: string | undefined): string {
    if (word === undefined || word === '') return ''
    const parts = word.split(/[/\\]/)
    const leaf = parts[parts.length - 1] ?? ''
    return leaf.toLowerCase().replace(ShellCommandKind.extensionConst, '')
  }
}
