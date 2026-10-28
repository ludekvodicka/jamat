import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { FileTail } from '../../shared/fileTail'

/** Saved run logs, `<directory>/<parentId>/<runId>.log`, so one parent's removal takes all of its logs. */
export class ScriptLogStore {
  /** Ids arrive from records and from the CLI; anything else could name a path outside the folder. */
  private static readonly plainIdConst = /^[A-Za-z0-9_-]{1,128}$/
  private static readonly ownerOnlyFileConst = 0o600

  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  private static isPlainId(value: string): boolean {
    return ScriptLogStore.plainIdConst.test(value)
  }

  /** An id that is not a plain id is refused, never joined. */
  pathOf(parentId: string, runId: string): string {
    return join(this.parentDirectory(parentId), `${ScriptLogStore.checked(runId)}.log`)
  }

  /** The conflict brief an SVN action hands its resolver, kept beside the parent's run logs and gone with them. */
  briefPathOf(parentId: string, actionId: string): string {
    return join(this.parentDirectory(parentId), `${ScriptLogStore.checked(actionId)}-conflicts.txt`)
  }

  /** The merger's brief of an SVN Finish, Markdown, beside the parent's run logs and gone with them. */
  mergeBriefPathOf(parentId: string, actionId: string): string {
    return join(this.parentDirectory(parentId), `${ScriptLogStore.checked(actionId)}-merge.md`)
  }

  /** The brief of the agent the person starts on a waiting SVN action, Markdown, beside the parent's run logs and gone with them. */
  helpBriefPathOf(parentId: string, actionId: string): string {
    return join(this.parentDirectory(parentId), `${ScriptLogStore.checked(actionId)}-help.md`)
  }

  async write(parentId: string, runId: string, text: string): Promise<{ ok: true; bytes: number } | { ok: false; detail: string }> {
    return this.written(parentId, () => this.pathOf(parentId, runId), text)
  }

  async writeBrief(parentId: string, actionId: string, text: string): Promise<{ ok: true; bytes: number } | { ok: false; detail: string }> {
    return this.written(parentId, () => this.briefPathOf(parentId, actionId), text)
  }

  async writeMergeBrief(parentId: string, actionId: string, text: string): Promise<{ ok: true; bytes: number } | { ok: false; detail: string }> {
    return this.written(parentId, () => this.mergeBriefPathOf(parentId, actionId), text)
  }

  async writeHelpBrief(parentId: string, actionId: string, text: string): Promise<{ ok: true; bytes: number } | { ok: false; detail: string }> {
    return this.written(parentId, () => this.helpBriefPathOf(parentId, actionId), text)
  }

  async writeCommitFiles(parentId: string, actionId: string, selection: readonly string[], message: string)
    : Promise<{ ok: true; targetsFile: string; messageFile: string } | { ok: false; detail: string }> {
    const targetsFile = join(this.parentDirectory(parentId), `${ScriptLogStore.checked(actionId)}-targets.txt`)
    const messageFile = join(this.parentDirectory(parentId), `${ScriptLogStore.checked(actionId)}-message.txt`)
    const targets = await this.written(parentId, () => targetsFile, selection.map((path) => `${path}@`).join('\n') + '\n')
    if (!targets.ok) return targets
    const text = await this.written(parentId, () => messageFile, message)
    return text.ok ? { ok: true, targetsFile, messageFile } : text
  }

  /** The same staging rule as `AtomicJsonFile.writeAsync`: a reader sees the old file or the whole new one. */
  private async written(parentId: string, fileOf: () => string, text: string): Promise<{ ok: true; bytes: number } | { ok: false; detail: string }> {
    let temporaryFile: string | null = null
    let committed = false
    try {
      const file = fileOf()
      await mkdir(this.parentDirectory(parentId), { recursive: true })
      temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporaryFile, text, { encoding: 'utf-8', mode: ScriptLogStore.ownerOnlyFileConst })
      await rename(temporaryFile, file)
      committed = true
      return { ok: true, bytes: Buffer.byteLength(text, 'utf8') }
    } catch (error) {
      return { ok: false, detail: ErrorText.of(error) }
    } finally {
      if (!committed && temporaryFile !== null)
        try { await unlink(temporaryFile) } catch { /* absent or already moved */ }
    }
  }

  /** The last `maxBytes` of the log, or null when there is none or the ids are not plain. */
  async read(parentId: string, runId: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
    if (!ScriptLogStore.isPlainId(parentId) || !ScriptLogStore.isPlainId(runId)) return null
    const file = this.pathOf(parentId, runId)
    try {
      const { size } = await stat(file)
      const { content, startedAtFileBeginning } = await FileTail.readBounded(file, size, maxBytes)
      return { text: content, truncated: !startedAtFileBeginning }
    } catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return null
      throw error
    }
  }

  /** The log's path while it is a file on disk; null when it is not, or when the ids are not plain. */
  async existingPathOf(parentId: string, runId: string): Promise<string | null> {
    if (!ScriptLogStore.isPlainId(parentId) || !ScriptLogStore.isPlainId(runId)) return null
    const file = this.pathOf(parentId, runId)
    try {
      return (await stat(file)).isFile() ? file : null
    } catch (error) {
      const code = ErrnoCode.of(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
  }

  async removeRun(parentId: string, runId: string): Promise<void> {
    await rm(this.pathOf(parentId, runId), { force: true })
  }

  async removeParent(parentId: string, keepIds: readonly string[] = []): Promise<void> {
    const directory = this.parentDirectory(parentId)
    if (keepIds.length === 0) {
      await rm(directory, { recursive: true, force: true })
      return
    }
    const keep = new Set(keepIds.flatMap((id) => ['.log', '-conflicts.txt', '-merge.md', '-help.md', '-targets.txt', '-message.txt']
      .map((suffix) => `${ScriptLogStore.checked(id)}${suffix}`)))
    let names: string[]
    try { names = await readdir(directory) }
    catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return
      throw error
    }
    for (const name of names)
      if (!keep.has(name) && !name.endsWith('.tmp')) await unlink(join(directory, name))
  }

  /** Deletes the folder of every parent not in `parentIds` last changed before `olderThan`; answers how many went. */
  async sweep(parentIds: ReadonlySet<string>, olderThan: number): Promise<number> {
    let entries
    try {
      entries = await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || parentIds.has(entry.name)) continue
      const folder = join(this.directory, entry.name)
      if ((await stat(folder)).mtimeMs >= olderThan) continue
      await rm(folder, { recursive: true, force: true })
      removed += 1
    }
    return removed
  }

  private parentDirectory(parentId: string): string {
    return join(this.directory, ScriptLogStore.checked(parentId))
  }

  private static checked(id: string): string {
    if (!ScriptLogStore.isPlainId(id)) throw new Error(`Not a plain id: ${JSON.stringify(id)}`)
    return id
  }
}
