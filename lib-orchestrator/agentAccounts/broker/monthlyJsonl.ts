import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One JSONL file per UTC month (`YYYY-MM.jsonl`), shared by the caller log and the usage log. */
export class MonthlyJsonl {
  private static readonly fileNameConst = /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/

  static async append(directory: string, at: number, value: unknown): Promise<void> {
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${new Date(at).toISOString().slice(0, 7)}.jsonl`)
    // A crashed append can leave a partial JSON value; separate the next record from that tail.
    let prefix = ''
    try {
      const existing = await readFile(file, 'utf8')
      if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n'
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await appendFile(file, prefix + JSON.stringify(value) + '\n', 'utf8')
  }

  /** The month file names, in no particular order; none when the directory does not exist yet. */
  static async files(directory: string): Promise<string[]> {
    try { return (await readdir(directory)).filter(file => MonthlyJsonl.fileNameConst.test(file)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Each line of a month file parsed by `entryOf`; a line that is no JSON or no entry is skipped. */
  static async read<T>(directory: string, file: string, entryOf: (value: unknown) => T | null): Promise<T[]> {
    const entries: T[] = []
    for (const line of (await readFile(join(directory, file), 'utf8')).split('\n')) {
      let entry: T | null
      try { entry = entryOf(JSON.parse(line)) } catch { continue }
      if (entry) entries.push(entry)
    }
    return entries
  }

  static monthEnd(file: string): number {
    const start = new Date(`${file.slice(0, 7)}-01T00:00:00Z`)
    return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
  }
}
