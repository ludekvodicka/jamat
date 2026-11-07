import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'

import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { JsonShape } from '../../shared/jsonShape'
import type { ErasureReport } from './agentHistoryEraser.types'

/**
 * The deletions of one erase and what each of them came to. Every path it is handed is built from a
 * checked conversation id or a Jamat session id, never from text a store wrote, so nothing here can
 * be steered outside the folder it was meant for.
 */
export class ErasureLedger {
  private static readonly conversationIdPatternConst = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  private static readonly rewriteAttemptsConst = 3

  readonly report: ErasureReport

  constructor() {
    this.report = { erased: [], leftovers: [], notes: [] }
  }

  /** Claude and Codex both name a conversation by a UUID; anything else is not used in a path. */
  static conversationId(id: string): boolean {
    return ErasureLedger.conversationIdPatternConst.test(id)
  }

  static async entries(directory: string): Promise<Dirent[]> {
    try { return await readdir(directory, { withFileTypes: true }) }
    catch { return [] }
  }

  /** A file, or a folder with everything in it. An absent path is not reported: there was nothing. */
  async remove(path: string): Promise<void> {
    try { await lstat(path) }
    catch (error) {
      if (ErrnoCode.of(error) !== 'ENOENT') this.report.leftovers.push(`${path}: ${ErrorText.of(error)}`)
      return
    }
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 })
      this.report.erased.push(path)
    }
    catch (error) { this.report.leftovers.push(`${path}: ${ErrorText.of(error)}`) }
  }

  /**
   * Drops the lines of a JSONL file whose `field` names one of `ids`. The file belongs to an agent
   * that appends to it while it runs, so the copy replaces it only when its size and time did not
   * move during the rewrite; a line appended meanwhile is read again by the next attempt.
   */
  async dropLines(file: string, field: string, ids: readonly string[]): Promise<void> {
    try {
      for (let attempt = 0; attempt < ErasureLedger.rewriteAttemptsConst; attempt++) {
        let before
        try { before = await stat(file) }
        catch (error) {
          if (ErrnoCode.of(error) === 'ENOENT') return
          throw error
        }
        const lines = (await readFile(file, 'utf8')).split('\n')
        const kept = lines.filter((line) => !ErasureLedger.names(line, field, ids))
        if (kept.length === lines.length) return
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(temporary, kept.join('\n'), { encoding: 'utf8', mode: before.mode & 0o777 })
        const after = await stat(file)
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          await rm(temporary, { force: true })
          continue
        }
        try { await rename(temporary, file) }
        catch (error) {
          await rm(temporary, { force: true })
          throw error
        }
        this.report.erased.push(`${lines.length - kept.length} line(s) of ${file}`)
        return
      }
      this.report.leftovers.push(`${file}: it changed during each of ${ErasureLedger.rewriteAttemptsConst} rewrites`)
    }
    catch (error) { this.report.leftovers.push(`${file}: ${ErrorText.of(error)}`) }
  }

  private static names(line: string, field: string, ids: readonly string[]): boolean {
    if (!ids.some((id) => line.includes(id))) return false
    let parsed: unknown
    try { parsed = JSON.parse(line) }
    catch { return false }
    const value = JsonShape.record(parsed)?.[field]
    return typeof value === 'string' && ids.includes(value)
  }
}
