import { open, stat } from 'node:fs/promises'

import { z } from 'zod'

import {
  sessionMutationExtractor,
  type SessionMutationBatch,
  type SessionMutationExtractor,
  type SessionMutationRole,
} from '../../fileChangesManager/sessionMutationsView'
import type { FileChangesAgentId } from '../../fileChangesManager/fileChangesManagerApi.types'

const count = z.number().int().nonnegative()

export const transcriptCursorSchema = z.object({
  agentId: z.enum(['claude', 'codex', 'antigravity']),
  role: z.enum(['session', 'subagent']),
  identity: z.string(),
  size: count,
  mtimeMs: z.number().finite(),
  offset: count,
  carry: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  extractor: z.unknown(),
}).refine((cursor) => cursor.offset <= cursor.size && Buffer.from(cursor.carry, 'base64').length <= cursor.offset)

export type TranscriptCursorState = z.infer<typeof transcriptCursorSchema>

/**
 * Where the reading of one transcript stopped, in the shape of `TokenUsageScanner`: the byte offset,
 * the bytes of a line not finished yet (base64), and the file's identity. A new identity, a shorter
 * file or an older time starts the file again; the claims taken from the old content stay with the
 * session, which is the caller's. Only the bytes after `offset` are read, in 64 KiB chunks split at
 * `\n`, so a record or a multi-byte character across a chunk boundary is decoded once and whole.
 */
export class TranscriptCursor {
  static readonly chunkBytesConst = 65_536

  private readonly agentId: FileChangesAgentId
  private readonly role: SessionMutationRole
  private saved: TranscriptCursorState | null

  constructor(agentId: FileChangesAgentId, role: SessionMutationRole, saved: TranscriptCursorState | null = null) {
    this.agentId = agentId
    this.role = role
    this.saved = saved !== null && saved.agentId === agentId && saved.role === role ? saved : null
  }

  /** Plain JSON for the cache; null before the first read. */
  state(): TranscriptCursorState | null {
    return this.saved
  }

  /** `'unchanged'` costs one `stat`. A file that vanished throws, as `stat` does. */
  async read(file: string): Promise<SessionMutationBatch | 'unchanged'> {
    const stats = await stat(file)
    const identity = stats.ino ? `${stats.dev}:${stats.ino}:${stats.birthtimeMs}` : file
    const previous = this.saved
    if (previous !== null && previous.identity === identity && previous.size === stats.size
      && previous.mtimeMs === stats.mtimeMs && previous.offset === stats.size)
      return 'unchanged'
    const restart = previous === null || previous.identity !== identity
      || stats.size < previous.size || stats.mtimeMs < previous.mtimeMs
    let extractor = restart ? null : this.restored(previous.extractor)
    const start = extractor === null ? { offset: 0, carry: Buffer.alloc(0) } : { offset: previous!.offset, carry: Buffer.from(previous!.carry, 'base64') }
    extractor ??= sessionMutationExtractor(this.agentId, this.role)
    const end = await this.append(file, extractor, start, stats.size)
    this.saved = {
      agentId: this.agentId,
      role: this.role,
      identity,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      offset: end.offset,
      carry: end.carry.toString('base64'),
      extractor: extractor.state(),
    }
    return extractor.drain()
  }

  /** A state another version wrote is read again from the file's start rather than trusted. */
  private restored(state: unknown): SessionMutationExtractor | null {
    try { return sessionMutationExtractor(this.agentId, this.role, state) }
    catch { return null }
  }

  private async append(
    file: string,
    extractor: SessionMutationExtractor,
    start: { offset: number; carry: Buffer },
    end: number,
  ): Promise<{ offset: number; carry: Buffer }> {
    let { offset, carry } = start
    if (offset >= end) return { offset, carry }
    const handle = await open(file, 'r')
    try {
      while (offset < end) {
        const buffer = Buffer.alloc(Math.min(TranscriptCursor.chunkBytesConst, end - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead === 0) break
        offset += bytesRead
        const content = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
        const lines: string[] = []
        let from = 0
        for (let newline = content.indexOf(10, from); newline >= 0; newline = content.indexOf(10, from)) {
          lines.push(content.subarray(from, newline).toString('utf8'))
          from = newline + 1
        }
        carry = content.subarray(from)
        extractor.push(lines)
      }
    }
    finally { await handle.close() }
    return { offset, carry }
  }
}
