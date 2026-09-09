import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

interface SessionIndexRecord {
  id?: unknown
  thread_name?: unknown
}

interface ThreadNamesCache {
  mtimeMilliseconds: number
  size: number
  names: Map<string, string>
}

/**
 * The names Codex gives its own threads, read from `<codexHome>/session_index.jsonl`.
 *
 * The file is Codex's, append-only, and this class only ever reads it. Writing a name of ours into
 * it would put our record in another application's log, where the next Codex release is free to
 * reject it - and where nothing of ours would ever clean it up.
 *
 * Duplicate ids are the normal case, not corruption: a rename appends a second record for the same
 * id, so the last VALID record wins. A half-written trailing line is equally normal, since the file
 * is appended to while we read it, so an unparsable line is skipped rather than failing the load.
 */
export class CodexThreadNames {
  private static readonly indexFileNameConst = 'session_index.jsonl'
  private static readonly sessionIdPatternConst =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  private cache: ThreadNamesCache | null = null

  constructor(private readonly codexHome: string) {}

  async titleOf(sessionId: string): Promise<string | null> {
    return (await this.load()).get(sessionId) ?? null
  }

  /**
   * Keyed on mtime and size rather than a generation counter: the file is written by another
   * process, so an explicit invalidation from our side could never be the thing that notices.
   */
  private async load(): Promise<ReadonlyMap<string, string>> {
    const file = join(this.codexHome, CodexThreadNames.indexFileNameConst)
    let mtimeMilliseconds: number
    let size: number
    try {
      const stats = await stat(file)
      mtimeMilliseconds = stats.mtimeMs
      size = stats.size
    } catch {
      this.cache = null
      return new Map()
    }
    const cached = this.cache
    if (cached && cached.mtimeMilliseconds === mtimeMilliseconds && cached.size === size)
      return cached.names
    let content: string
    try { content = await readFile(file, 'utf8') }
    catch {
      this.cache = null
      return new Map()
    }
    const names = CodexThreadNames.parse(content)
    this.cache = { mtimeMilliseconds, size, names }
    return names
  }

  private static parse(content: string): Map<string, string> {
    const names = new Map<string, string>()
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      let record: SessionIndexRecord
      try { record = JSON.parse(line) as SessionIndexRecord }
      catch { continue }
      if (typeof record.id !== 'string' || !CodexThreadNames.sessionIdPatternConst.test(record.id))
        continue
      if (typeof record.thread_name !== 'string') continue
      const name = record.thread_name.trim()
      if (name) names.set(record.id, name)
      else names.delete(record.id)
    }
    return names
  }
}
