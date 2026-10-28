import { randomUUID } from 'node:crypto'
import type { RemoteContentCursor, RemoteContentPage } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'

export class RemoteContentPages {
  private readonly held = new Map<string, { owner: string; version: string; bytes: Buffer; expires: number }>()

  put(owner: string, value: unknown): RemoteControlStepResult<RemoteContentPage> {
    this.prune()
    const bytes = Buffer.from(JSON.stringify(value), 'utf8')
    if (bytes.length > 16 * 1024 * 1024)
      return { ok: false, error: { code: 'unavailable', detail: 'Source result exceeds the content limit' } }
    while (this.held.size >= 64 || [...this.held.values()].reduce((sum, entry) => sum + entry.bytes.length, 0) + bytes.length > 64 * 1024 * 1024)
      this.held.delete(this.held.keys().next().value!)
    const transferId = randomUUID()
    const version = randomUUID()
    this.held.set(transferId, { owner, version, bytes, expires: Date.now() + 60_000 })
    return this.read(owner, { transferId, version, offset: 0 })
  }

  read(owner: string, cursor: RemoteContentCursor): RemoteControlStepResult<RemoteContentPage> {
    this.prune()
    const held = this.held.get(cursor.transferId)
    if (!held || held.owner !== owner || held.version !== cursor.version)
      return { ok: false, error: { code: 'forbidden', detail: 'Content transfer is expired or belongs to another view' } }
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= held.bytes.length)
      return { ok: false, error: { code: 'invalid-request', detail: 'Invalid content page offset' } }
    held.expires = Date.now() + 60_000
    const page = { ...cursor, totalBytes: held.bytes.length, base64: held.bytes.subarray(cursor.offset, cursor.offset + 64 * 1024).toString('base64') }
    if (cursor.offset + 64 * 1024 >= held.bytes.length) this.held.delete(cursor.transferId)
    return { ok: true, value: page }
  }

  release(owner: string): void {
    for (const [id, held] of this.held)
      if (held.owner === owner) this.held.delete(id)
  }

  private prune(): void {
    for (const [id, held] of this.held)
      if (held.expires <= Date.now()) this.held.delete(id)
  }
}
