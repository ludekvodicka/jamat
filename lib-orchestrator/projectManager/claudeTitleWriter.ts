import { appendFile, open, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeConfigHome } from '../shared/claudeConfigHome'
import { ErrorText } from '../shared/errorText'
import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'

/**
 * A declared surface of the subsystem, and the first that WRITES. `CodexThreadNames` refuses to
 * write into Codex's index because that would put our record in another application's log; this
 * class may write into a Claude transcript because what it appends is OUR OWN read contract: the
 * `custom-title` record is exactly what `ClaudeSessionSource` reads back (last one wins), and the
 * same line shape Claude Code's own `/rename` appends - V1 wrote it for years and Claude Code
 * ignores record types it does not know. Append-only by construction, with the newline guard that
 * keeps the one-record-per-line contract, and a transcript that does not exist is never created:
 * a session without provider history has nothing there to rename.
 */
export class ClaudeTitleWriter {
  private static readonly sessionIdPatternConst =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  private static readonly titleLimitConst = 200

  private constructor(
    private readonly locator: ClaudeProjectsLocator,
    private readonly report: (message: string) => void,
  ) {}

  static load(options?: {
    claudeHome?: string
    report?: (message: string) => void
  }): ClaudeTitleWriter {
    const home = ClaudeConfigHome.resolve(options?.claudeHome)
    return new ClaudeTitleWriter(new ClaudeProjectsLocator(home), options?.report ?? (() => undefined))
  }

  /** False = not written: missing transcript, malformed id, empty name, or an I/O failure. */
  async appendTitle(input: {
    cwd: string
    nativeSessionId: string
    title: string
  }): Promise<boolean> {
    if (!ClaudeTitleWriter.sessionIdPatternConst.test(input.nativeSessionId)) return false
    // A literal newline in the title would break the JSONL one-record-per-line contract. The cap
    // counts code points, not UTF-16 units: a string slice can cut through an emoji and leave a
    // lone surrogate, which JSON.stringify escapes into a record no strict reader accepts.
    const safe = [...input.title.replace(/[\r\n]+/g, ' ').trim()]
      .slice(0, ClaudeTitleWriter.titleLimitConst)
      .join('')
    if (safe === '') return false
    const directory = await this.locator.resolveProjectDir(input.cwd)
    if (directory === null) return false
    const file = join(directory, `${input.nativeSessionId}.jsonl`)
    let size: number
    try {
      size = (await stat(file)).size
    } catch { return false }
    let line = JSON.stringify({
      type: 'custom-title',
      customTitle: safe,
      sessionId: input.nativeSessionId,
    }) + '\n'
    try {
      // A tail without '\n' (a write in flight, a crash) would fuse our record onto the previous
      // one and corrupt that segment for every future parse. Prepend the newline it is missing.
      if (size > 0 && await ClaudeTitleWriter.lastByteIsNotNewline(file, size)) line = '\n' + line
      await appendFile(file, line, 'utf8')
      return true
    } catch (thrown) {
      this.report(
        `The title of ${input.nativeSessionId} was not appended to its Claude transcript: `
        + ErrorText.of(thrown),
      )
      return false
    }
  }

  private static async lastByteIsNotNewline(file: string, size: number): Promise<boolean> {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(1)
      const { bytesRead } = await handle.read(buffer, 0, 1, size - 1)
      return bytesRead === 1 && buffer[0] !== 0x0a
    } finally {
      await handle.close()
    }
  }
}
