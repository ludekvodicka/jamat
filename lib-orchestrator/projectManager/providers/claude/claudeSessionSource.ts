import type { Stats } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeConfigHome } from '../../../shared/claudeConfigHome'
import type { ProviderSessionSummary } from '../../projectManagerApi.types'
import type { ProviderAgentId, ProviderSessionSource } from '../providerContract.types'
import { ClaudeProjectsLocator } from './claudeProjectsLocator'

interface TranscriptMetadata {
  sessionId: string
  title: string | null
  firstUserMessage: string | null
}

interface MemoEntry {
  mtimeMs: number
  size: number
  metadata: TranscriptMetadata | null
}

interface TranscriptRecord {
  sessionId?: unknown
  slug?: unknown
  type?: unknown
  customTitle?: unknown
  message?: { content?: unknown }
}

/**
 * A project's Claude history, read under hard caps. Transcripts reach gigabytes and an active one is
 * being appended to while this reads it, so nothing here ever loads a whole file: the metadata comes
 * from a bounded header and the current name from a bounded tail. Times come from the file, not from
 * the transcript, which keeps a listing at one stat per session.
 */
export class ClaudeSessionSource implements ProviderSessionSource {
  private static readonly headerLinesConst = 20
  private static readonly headerBytesConst = 128 * 1024
  private static readonly titleTailBytesConst = 64 * 1024
  private static readonly customTitleMarkerConst = '"type":"custom-title"'
  private static readonly messageLengthConst = 120
  private static readonly transcriptSuffixConst = '.jsonl'

  readonly agentId: ProviderAgentId = 'claude'
  private readonly claudeHome: string
  private readonly locator: ClaudeProjectsLocator
  private readonly memo = new Map<string, MemoEntry>()
  private generation = 0

  constructor(deps: { claudeHome?: string; locator?: ClaudeProjectsLocator }) {
    this.claudeHome = ClaudeConfigHome.resolve(deps.claudeHome)
    this.locator = deps.locator ?? new ClaudeProjectsLocator(this.claudeHome)
  }

  async listProjectSessions(
    projectDir: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<ProviderSessionSummary[]> {
    const directory = await this.locator.resolveProjectDir(projectDir)
    if (!directory) return []
    const names = await ClaudeSessionSource.transcriptNames(directory)
    if (names.length === 0) return []
    const activeIds = await this.activeSessionIds()
    const summaries: ProviderSessionSummary[] = []
    for (const name of names) {
      // Nobody is waiting for an aborted listing, so what was already read is handed back as it is.
      if (options.signal?.aborted) break
      const summary = await this.summaryOf(join(directory, name), activeIds)
      if (summary) summaries.push(summary)
    }
    summaries.sort((left, right) => right.lastActivity - left.lastActivity)
    return summaries.slice(0, options.limit)
  }

  async latestActivity(projectDir: string): Promise<number | null> {
    const directory = await this.locator.resolveProjectDir(projectDir)
    if (!directory) return null
    let newest = -1
    for (const name of await ClaudeSessionSource.transcriptNames(directory)) {
      const stats = await ClaudeSessionSource.statOf(join(directory, name))
      if (stats && stats.mtimeMs > newest) newest = stats.mtimeMs
    }
    return newest < 0 ? null : newest
  }

  invalidate(): void {
    this.generation += 1
    this.memo.clear()
    this.locator.invalidate()
  }

  private static async transcriptNames(directory: string): Promise<string[]> {
    try {
      const names = await readdir(directory)
      return names.filter((name) => name.endsWith(ClaudeSessionSource.transcriptSuffixConst))
    } catch {
      return []
    }
  }

  private async summaryOf(
    file: string,
    activeIds: ReadonlySet<string>,
  ): Promise<ProviderSessionSummary | null> {
    const stats = await ClaudeSessionSource.statOf(file)
    if (!stats) return null
    const metadata = await this.metadataOf(file, stats.mtimeMs, stats.size)
    if (!metadata) return null
    return {
      agentId: 'claude',
      nativeSessionId: metadata.sessionId,
      title: metadata.title,
      firstUserMessage: metadata.firstUserMessage,
      createdAt: stats.birthtimeMs,
      lastActivity: stats.mtimeMs,
      active: activeIds.has(metadata.sessionId),
    }
  }

  private async metadataOf(
    file: string,
    mtimeMs: number,
    size: number,
  ): Promise<TranscriptMetadata | null> {
    const cached = this.memo.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.metadata
    const generation = this.generation
    let metadata: TranscriptMetadata | null = null
    try {
      metadata = await ClaudeSessionSource.readMetadata(file)
    } catch { /* an unreadable transcript is skipped; the other sessions still list */ }
    // A listing that started before invalidate() must not put its now-stale reading back in the memo.
    if (generation === this.generation) this.memo.set(file, { mtimeMs, size, metadata })
    return metadata
  }

  private static async readMetadata(file: string): Promise<TranscriptMetadata | null> {
    let sessionId = ''
    let title: string | null = null
    let firstUserMessage: string | null = null
    for (const line of await ClaudeSessionSource.readHeaderLines(file)) {
      const record = ClaudeSessionSource.parseRecord(line)
      if (!record) continue
      if (!sessionId && ClaudeSessionSource.filledString(record.sessionId))
        sessionId = record.sessionId
      if (!title && ClaudeSessionSource.filledString(record.slug)) title = record.slug
      if (!firstUserMessage && record.type === 'user')
        firstUserMessage = ClaudeSessionSource.firstMessageOf(record)
    }
    if (!sessionId) return null
    const customTitle = await ClaudeSessionSource.readCustomTitle(file)
    return { sessionId, title: customTitle ?? title, firstUserMessage }
  }

  /**
   * Bounded on both axes. The identifying records are written at the head of the transcript, so
   * reading past the first chunk buys nothing and would stall a listing on a multi-gigabyte file.
   */
  private static async readHeaderLines(file: string): Promise<string[]> {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(ClaudeSessionSource.headerBytesConst)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer
        .toString('utf8', 0, bytesRead)
        .split('\n')
        .slice(0, ClaudeSessionSource.headerLinesConst)
        .filter(Boolean)
    } finally {
      await handle.close()
    }
  }

  /**
   * Only the tail: /rename appends a record rather than editing one, so the last record in the file
   * is the current name and the ones before it are history. The first line of the window is usually
   * cut in half, fails to parse and is ignored.
   */
  private static async readCustomTitle(file: string): Promise<string | null> {
    const handle = await open(file, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(ClaudeSessionSource.titleTailBytesConst, size)
      if (length === 0) return null
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, size - length)
      return ClaudeSessionSource.lastCustomTitleIn(buffer.toString('utf8', 0, bytesRead))
    } finally {
      await handle.close()
    }
  }

  private static lastCustomTitleIn(text: string): string | null {
    const marker = ClaudeSessionSource.customTitleMarkerConst
    let title: string | null = null
    let position = text.indexOf(marker)
    while (position !== -1) {
      const lineStart = text.lastIndexOf('\n', position) + 1
      const lineEnd = text.indexOf('\n', position)
      const record = ClaudeSessionSource.parseRecord(
        text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
      )
      if (record && ClaudeSessionSource.filledString(record.customTitle)) title = record.customTitle
      position = text.indexOf(marker, position + marker.length)
    }
    return title
  }

  private static firstMessageOf(record: TranscriptRecord): string | null {
    const text = ClaudeSessionSource.userTextOf(record.message?.content)
    if (!text) return null
    const cleaned = ClaudeSessionSource.sanitize(text)
    return cleaned.length > 0 ? cleaned : null
  }

  /** A string opening with '<' is Claude Code's own injected context, not something the user typed. */
  private static userTextOf(content: unknown): string | null {
    if (typeof content === 'string')
      return content.length > 3 && !content.startsWith('<') ? content : null
    if (!Array.isArray(content)) return null
    for (const block of content as { type?: unknown; text?: unknown }[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 3)
        return block.text
    }
    return null
  }

  /**
   * The image placeholders and the newlines around them would otherwise show up as visible
   * indentation in a one-line row and break the alignment of every row beside it.
   */
  private static sanitize(text: string): string {
    return text
      .replace(/\[Image\s*#?\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, ClaudeSessionSource.messageLengthConst)
  }

  /**
   * A session counts as running when some `<claudeHome>/sessions/*.json` names it and the pid it
   * recorded still answers. It is what covers sessions started outside this application.
   */
  private async activeSessionIds(): Promise<ReadonlySet<string>> {
    const directory = join(this.claudeHome, 'sessions')
    const ids = new Set<string>()
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return ids
    }
    for (const name of names) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'))
        const record = parsed as { sessionId?: unknown; pid?: unknown }
        if (!ClaudeSessionSource.filledString(record.sessionId)) continue
        if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0)
          continue
        process.kill(record.pid, 0)
        ids.add(record.sessionId)
      } catch { /* unusable record, or a pid that no longer answers */ }
    }
    return ids
  }

  private static async statOf(file: string): Promise<Stats | null> {
    try {
      return await stat(file)
    } catch {
      return null
    }
  }

  private static parseRecord(line: string): TranscriptRecord | null {
    try {
      return JSON.parse(line) as TranscriptRecord
    } catch {
      return null
    }
  }

  private static filledString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
  }
}
